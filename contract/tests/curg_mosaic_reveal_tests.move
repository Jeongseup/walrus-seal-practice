#[test_only]
module curg_mosaic_reveal::mosaic_tests;

use curg_mosaic_reveal::mosaic::{Self, Game, OracleCap};
use std::string;
use sui::clock;
use sui::coin;
use sui::hash::keccak256;
use sui::sui::SUI;
use sui::test_scenario;

const ADMIN: address = @0xAD;
const PLAYER_A: address = @0xA;
const PLAYER_B: address = @0xB;

#[test]
fun test_game_flow_complete() {
    let mut scenario_val = test_scenario::begin(ADMIN);
    let scenario = &mut scenario_val;
    let clock = clock::create_for_testing(test_scenario::ctx(scenario));

    // 1. 초기화 & 게임 생성
    test_scenario::next_tx(scenario, ADMIN);
    {
        mosaic::init_for_testing(test_scenario::ctx(scenario));
    };

    test_scenario::next_tx(scenario, ADMIN);
    {
        let answer = b"sui";
        // [Warning 해결] 변수명 앞에 _를 붙여 사용하지 않음을 명시하거나 바로 사용
        let answer_hash = keccak256(&answer);

        let mut encrypted_keys = vector::empty();
        let mut i = 0;
        while (i < 100) {
            vector::push_back(&mut encrypted_keys, b"encrypted_blob_key");
            i = i + 1;
        };

        mosaic::create_game(
            answer_hash,
            string::utf8(b"walrus_blob_123"),
            encrypted_keys,
            test_scenario::ctx(scenario),
        );
    };

    // 2. Player A가 0번 타일 공개 요청
    test_scenario::next_tx(scenario, PLAYER_A);
    {
        // [수정 3] Game 타입을 명시적으로 가져옴 (Unbound Type 해결)
        let mut game = test_scenario::take_shared<Game>(scenario);
        let payment = coin::mint_for_testing<SUI>(1_000_000_000, test_scenario::ctx(scenario));

        mosaic::request_reveal(&mut game, 0, payment, test_scenario::ctx(scenario));

        test_scenario::return_shared(game);
    };

    // 3. Oracle(Admin)이 0번 타일 키 공개
    test_scenario::next_tx(scenario, ADMIN);
    {
        let mut game = test_scenario::take_shared<Game>(scenario);
        let cap = test_scenario::take_from_sender<OracleCap>(scenario);

        let decrypted_key = b"real_aes_key_for_tile_0";
        mosaic::fulfill_reveal(&cap, &mut game, 0, decrypted_key);

        test_scenario::return_to_sender(scenario, cap);
        test_scenario::return_shared(game);
    };

    // 4. Player B가 정답 맞추기 시도 (Commit)
    test_scenario::next_tx(scenario, PLAYER_B);
    {
        let mut game = test_scenario::take_shared<Game>(scenario);

        let answer = b"sui";
        let user_salt = b"my_secret_salt";

        let mut commit_payload = vector::empty();
        vector::append(&mut commit_payload, answer);
        vector::append(&mut commit_payload, user_salt);
        let commit_hash = keccak256(&commit_payload);

        mosaic::commit_guess(&mut game, commit_hash, &clock, test_scenario::ctx(scenario));

        test_scenario::return_shared(game);
    };

    // 5. Player B가 정답 공개 (Reveal)
    test_scenario::next_tx(scenario, PLAYER_B);
    {
        let mut game = test_scenario::take_shared<Game>(scenario);

        let answer = b"sui";
        let user_salt = b"my_secret_salt";

        // [수정 4] 가장 중요한 에러 수정! (Cannot infer type)
        // 빈 벡터를 만들 때 어떤 타입인지 <u8>을 명시해야 함
        let game_salt = vector::empty<u8>();

        mosaic::solve(
            &mut game,
            answer,
            user_salt,
            game_salt,
            &clock,
            test_scenario::ctx(scenario),
        );

        test_scenario::return_shared(game);
    };

    // 6. 상금 확인
    test_scenario::next_tx(scenario, PLAYER_B);
    {
        let game = test_scenario::take_shared<Game>(scenario);
        test_scenario::return_shared(game);
    };

    clock::destroy_for_testing(clock);
    test_scenario::end(scenario_val);
}
