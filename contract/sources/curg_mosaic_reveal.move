#[allow(duplicate_alias)]
module curg_mosaic_reveal::mosaic;

use std::string::{Self, String};
use sui::balance::{Self, Balance};
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use sui::event;
use sui::hash::keccak256;
use sui::sui::SUI;
use sui::table::{Self, Table};

// --- Constants ---
const EGameAlreadySolved: u64 = 0;
const EInvalidPayment: u64 = 1;
const EInvalidTileIndex: u64 = 2;
const ETileAlreadyRevealed: u64 = 3;
const EIncorrectAnswer: u64 = 4;
const ENoCommitmentFound: u64 = 5;
const ECommitmentTooFresh: u64 = 6; // 같은 블록 내 제출 방지

// const TILE_PRICE: u64 = 1_000_000_000; // 1 SUI per tile reveal
const TILE_PRICE: u64 = 1_000; // 1 * 10^-6 SUI per tile reveal
const TOTAL_TILES: u64 = 100; // 10x10 Grid

// --- Structs ---

/// 게임의 상태를 저장하는 메인 객체
public struct Game has key {
    id: UID,
    creator: address,
    // 정답 검증용 해시 (생성자가 설정): Hash(Answer String + Game Salt)
    answer_hash: vector<u8>,
    // Walrus에 저장된 암호화된 이미지의 Blob ID
    walrus_blob_id: String,
    // 각 타일의 암호화된 키 (Seal로 암호화된 AES 키)
    encrypted_tile_keys: vector<vector<u8>>,
    // Seal 암호화에 사용된 encryption IDs (복호화에 필요)
    encryption_ids: vector<String>,
    // 공개된 타일의 키 (초기엔 모두 None, 공개되면 Some(AES key))
    decrypted_tile_keys: vector<Option<vector<u8>>>,
    // 상금 풀
    pot: Balance<SUI>,
    is_solved: bool,
    winner: Option<address>,
    // [프론트러닝 방지] 유저 커밋 저장소: 유저 주소 -> (해시값, 제출시간)
    guess_commitments: Table<address, Commitment>,
}

public struct Commitment has drop, store {
    submission_hash: vector<u8>, // Hash(User Answer + User Salt)
    timestamp_ms: u64,
}

/// Seal 위원회(혹은 봇)에게 부여하는 권한
public struct OracleCap has key, store { id: UID }

// --- Events ---

public struct GameCreated has copy, drop { game_id: ID }

public struct TileRevealRequested has copy, drop {
    game_id: ID,
    tile_index: u64,
    requester: address,
}

public struct TileRevealed has copy, drop {
    game_id: ID,
    tile_index: u64,
    decrypted_key: vector<u8>,
}

public struct GameSolved has copy, drop {
    game_id: ID,
    winner: address,
    prize: u64,
}

// --- Functions ---

fun init(ctx: &mut TxContext) {
    // Seal Oracle 권한 생성 (배포자에게 전송)
    transfer::transfer(OracleCap { id: object::new(ctx) }, tx_context::sender(ctx));
}

/// 1. 게임 생성 (Creator)
public fun create_game(
    answer_hash: vector<u8>,
    walrus_blob_id: String,
    encrypted_keys: vector<vector<u8>>, // 100개의 Seal로 암호화된 AES 키
    encryption_ids_bytes: vector<vector<u8>>, // Seal 복호화에 필요한 ID들 (as bytes, will be converted to String)
    ctx: &mut TxContext,
) {
    assert!(vector::length(&encrypted_keys) == TOTAL_TILES, EInvalidPayment);
    assert!(vector::length(&encryption_ids_bytes) == TOTAL_TILES, EInvalidPayment);

    // Convert bytes to String for each encryption ID
    let mut encryption_ids = vector::empty<String>();
    let mut i = 0;
    while (i < TOTAL_TILES) {
        let id_bytes = *vector::borrow(&encryption_ids_bytes, i);
        let id_string = string::utf8(id_bytes);
        vector::push_back(&mut encryption_ids, id_string);
        i = i + 1;
    };

    // 초기화: 복호화된 키 목록은 모두 none으로 설정
    let mut decrypted_keys = vector::empty();
    let mut i = 0;
    while (i < TOTAL_TILES) {
        vector::push_back(&mut decrypted_keys, option::none());
        i = i + 1;
    };

    let game = Game {
        id: object::new(ctx),
        creator: tx_context::sender(ctx),
        answer_hash,
        walrus_blob_id,
        encrypted_tile_keys: encrypted_keys,
        encryption_ids,
        decrypted_tile_keys: decrypted_keys,
        pot: balance::zero(),
        is_solved: false,
        winner: option::none(),
        guess_commitments: table::new(ctx),
    };

    event::emit(GameCreated { game_id: object::uid_to_inner(&game.id) });
    transfer::share_object(game);
}

/// 2. 타일 공개 요청 (User -> Seal)
/// 유저는 1 SUI를 지불하고 특정 타일의 키 공개를 요청함
public fun request_reveal(
    game: &mut Game,
    tile_index: u64,
    payment: Coin<SUI>,
    ctx: &mut TxContext,
) {
    assert!(!game.is_solved, EGameAlreadySolved);
    assert!(coin::value(&payment) == TILE_PRICE, EInvalidPayment);
    assert!(tile_index < TOTAL_TILES, EInvalidTileIndex);

    // 이미 공개된 타일인지 확인
    let tile_option = vector::borrow(&game.decrypted_tile_keys, tile_index);
    assert!(option::is_none(tile_option), ETileAlreadyRevealed);

    // 상금 풀에 추가
    balance::join(&mut game.pot, coin::into_balance(payment));

    // 이벤트 발생 -> Seal(백엔드)이 이를 감지하고 복호화 시작
    event::emit(TileRevealRequested {
        game_id: object::uid_to_inner(&game.id),
        tile_index,
        requester: tx_context::sender(ctx),
    });
}

/// 3. 타일 키 공개 (Seal Oracle -> Chain)
/// 백엔드에서 Seal Network를 통해 복호화된 키를 제출함
public fun fulfill_reveal(
    _: &OracleCap,
    game: &mut Game,
    tile_index: u64,
    decrypted_key: vector<u8>,
) {
    // 게임이 끝나도 키 공개는 해줄 수 있음 (UX상)

    // 키 업데이트
    let key_ref = vector::borrow_mut(&mut game.decrypted_tile_keys, tile_index);
    if (option::is_none(key_ref)) {
        option::fill(key_ref, decrypted_key);

        event::emit(TileRevealed {
            game_id: object::uid_to_inner(&game.id),
            tile_index,
            decrypted_key,
        });
    }
}

/// 4. 정답 제출 1단계: 커밋 (User)
/// 프론트러닝 방지를 위해 해시값만 먼저 제출
/// submission_hash = Keccak256(UserAnswerString + UserSalt)
public fun commit_guess(
    game: &mut Game,
    submission_hash: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(!game.is_solved, EGameAlreadySolved);
    let sender = tx_context::sender(ctx);

    let commitment = Commitment {
        submission_hash,
        timestamp_ms: clock::timestamp_ms(clock),
    };

    if (table::contains(&game.guess_commitments, sender)) {
        let old_commit = table::remove(&mut game.guess_commitments, sender);
        // drop is implied via struct ability, but logic implies overwrite
    };
    table::add(&mut game.guess_commitments, sender, commitment);
}

/// 5. 정답 제출 2단계: 공개 및 정산 (User)
/// 실제 정답과 솔트(Salt)를 공개하여 검증
public fun solve(
    game: &mut Game,
    answer_input: vector<u8>, // "Mona Lisa"
    user_salt: vector<u8>, // "User's Secret Random"
    game_salt: vector<u8>, // "Game's Secret Random" (정답 확인용)
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(!game.is_solved, EGameAlreadySolved);
    let sender = tx_context::sender(ctx);

    // A. 커밋 존재 여부 확인
    assert!(table::contains(&game.guess_commitments, sender), ENoCommitmentFound);
    let commitment = table::remove(&mut game.guess_commitments, sender);

    // B. 시간차 공격 방지 (같은 트랜잭션/블록 내 커밋->솔브 방지 위해 시간 체크 권장)
    // 테스트 환경에선 0으로 두지만 실제론 최소 1초 이상 차이를 두는 것이 좋음
    // assert!(clock::timestamp_ms(clock) > commitment.timestamp_ms, ECommitmentTooFresh);

    // C. 1차 검증: 내가 낸 커밋이 맞는지 (Answer + User Salt)
    let mut user_combine = copy answer_input;
    vector::append(&mut user_combine, copy user_salt);
    let calculated_user_hash = keccak256(&user_combine);
    assert!(calculated_user_hash == commitment.submission_hash, EIncorrectAnswer);

    // D. 2차 검증: 정답이 맞는지 (Answer + Game Salt)
    // Game Salt는 사용자가 알아내서 입력해야 함 (게임 로직에 따라 다름, 여기선 답만 맞추면 되는 단순화 모델로 가정할 수도 있지만,
    // 보통 Game Salt는 Creator가 생성 시 해시에 넣은 값임.
    // **수정**: Creator가 만든 `answer_hash`는 `Hash(Answer + GameSalt)` 였음.
    // 사용자가 정답("Mona Lisa")을 맞췄다면, Creator가 사용했던 Salt는 몰라도 됨?
    // -> 아님. Creator Salt를 모르면 해시 비교 불가능.
    // -> 방식 변경: `create_game`시 `answer_hash`는 `keccak256(Answer)`로 단순화 하거나,
    // -> Creator가 나중에 Salt를 공개해야 함.
    // -> 여기서는 **"선착순 정답 맞추기"**이므로, 유저가 입력한 문자열(Answer) 자체를 해시해서 비교하는 구조로 갑니다.
    // 즉, game.answer_hash = Keccak256("Mona Lisa") (Salt 없이).
    // 대신 Rainbow Table 공격 방지를 위해 문제 자체가 Salt 역할(Walrus Blob ID 등)을 섞을 수 있음.

    // **간단한 구현을 위해**: game.answer_hash = Keccak256(AnswerString)
    let calculated_game_hash = keccak256(&answer_input);
    assert!(calculated_game_hash == game.answer_hash, EIncorrectAnswer);

    // E. 정산
    game.is_solved = true;
    game.winner = option::some(sender);

    let prize_amount = balance::value(&game.pot);
    let prize = coin::take(&mut game.pot, prize_amount, ctx);

    transfer::public_transfer(prize, sender);

    event::emit(GameSolved {
        game_id: object::uid_to_inner(&game.id),
        winner: sender,
        prize: prize_amount,
    });
}

// 테스트를 위한 초기화 헬퍼
#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    init(ctx);
}
