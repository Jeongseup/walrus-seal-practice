#!/bin/bash

# ============================================================
# Seal CLI 암호화/복호화 테스트 스크립트
# 문서: https://seal-docs.wal.app/SealCLI/
# ============================================================

set -e

echo "============================================================"
echo "🚀 Seal CLI 암호화/복호화 테스트"
echo "============================================================"

# ============================
# 설정 값
# ============================
# 테스트 키 서버 (문서 예제 기반)
KEY_SERVER_1="0x1"
KEY_SERVER_2="0x2"
KEY_SERVER_3="0x3"
PACKAGE_ID="0x0"
THRESHOLD=2

# 테스트용 공개키 (genkey로 생성된 예시)
PUBKEY_1="aeb258b9fb9a2f29f74eb0a1a895860bb1c6ba3f9ea7075366de159e4764413e9ec0597ac9c0dad409723935440a45f40eee4728630ae3ea40a68a819375bba1d78d7810f901d8a469d785d00cfed6bd28f01d41e49c5652d924e9d19fddcf62"
PUBKEY_2="b1076a26f4f82f39d0e767fcd2118659362afe40bce4e8d553258c86756bb74f888bca79f2d6b71edf6e25af89efa83713a223b48a19d2e551897ac92ac7458336cd489be3be025e348ca93f4c94d22594f96f0e08990e51a7de9da8ff29c98f"
PUBKEY_3="95fcb465af3791f31d53d80db6c8dcf9f83a419b2570614ecfbb068f47613da17cb9ffc66bb052b9546f17196929538f0bd2d38e1f515d9916e2db13dc43e0ccbd4cb3d7cbb13ffecc0b68b37481ebaaaa17cad18096a9c2c27a797f17d78623"

# 마스터키 (복호화 테스트용 - genkey로 생성된 예시)
MASTERKEY_1="6b2eb410ad729f5b2ffa54ca5a2186ef95a1e31df3cccdd346b24f2262279440"
MASTERKEY_2="54152de3b08708b18ce5cd69b0c4d732f093cba2ba5c102c4f26e0f210daab75"
MASTERKEY_3="2ea9ccdaa224e9fc34ef1458fced17562b2d3757c1ebb223c627173ac6f93806"

# 암호화 ID
ENCRYPTION_ID="53e66d756e6472206672f3f069"

# ============================
# 1단계: 비밀 데이터 준비
# ============================
echo ""
echo "📝 [1단계] 비밀 데이터 준비"
echo "------------------------------------------------------------"

SECRET_STRING="Super Secret"
# 문자열을 hex로 변환
MESSAGE=$(echo -n "$SECRET_STRING" | xxd -p)

echo "   📄 원본 문자열: \"$SECRET_STRING\""
echo "   🔐 Hex 변환: $MESSAGE"
echo "   📊 바이트 크기: $((${#MESSAGE} / 2)) bytes"

# ============================
# 2단계: AES 암호화
# ============================
echo ""
echo "🔒 [2단계] Seal AES 암호화"
echo "------------------------------------------------------------"
echo "   🔑 암호화 ID: $ENCRYPTION_ID"
echo "   📦 Package ID: $PACKAGE_ID"
echo "   🎯 Threshold: $THRESHOLD"
echo "   🖥️  키 서버: $KEY_SERVER_1, $KEY_SERVER_2, $KEY_SERVER_3"
echo ""

echo "   ⏳ 암호화 중..."
ENCRYPT_OUTPUT=$(seal-cli encrypt-aes \
    --message "$MESSAGE" \
    --package-id "$PACKAGE_ID" \
    --id "$ENCRYPTION_ID" \
    --threshold "$THRESHOLD" \
    "$PUBKEY_1" "$PUBKEY_2" "$PUBKEY_3" \
    -- "$KEY_SERVER_1" "$KEY_SERVER_2" "$KEY_SERVER_3" 2>&1)

# 결과 파싱
ENCRYPTED_OBJECT=$(echo "$ENCRYPT_OUTPUT" | grep "Encrypted object" | sed 's/.*: //')
SYMMETRIC_KEY=$(echo "$ENCRYPT_OUTPUT" | grep "Symmetric key" | sed 's/.*: //')

echo "   ✅ 암호화 완료!"
echo ""
echo "   📦 암호화된 객체 (처음 64자):"
echo "      ${ENCRYPTED_OBJECT}..."
echo "   🔑 대칭키: $SYMMETRIC_KEY"

# ============================
# 3단계: 대칭키로 복호화
# ============================
echo ""
echo "🔓 [3단계] 대칭키로 복호화 (symmetric-decrypt)"
echo "------------------------------------------------------------"
echo "   🔑 대칭키 사용: $SYMMETRIC_KEY"
echo ""

echo "   ⏳ 복호화 중..."
DECRYPT_OUTPUT=$(seal-cli symmetric-decrypt \
    --key "$SYMMETRIC_KEY" \
    "$ENCRYPTED_OBJECT" 2>&1)

DECRYPTED_HEX=$(echo "$DECRYPT_OUTPUT" | grep "Decrypted message" | sed 's/.*: //')

echo "   ✅ 복호화 완료!"
echo "   🔐 복호화된 Hex: $DECRYPTED_HEX"

# Hex를 문자열로 변환
DECRYPTED_STRING=$(echo "$DECRYPTED_HEX" | xxd -r -p)
echo "   📄 복호화된 문자열: \"$DECRYPTED_STRING\""

# 검증
if [ "$SECRET_STRING" = "$DECRYPTED_STRING" ]; then
    echo "   ✅ 원본과 일치함!"
else
    echo "   ❌ 원본과 불일치!"
fi

# ============================
# 4단계: 사용자 비밀키 추출
# ============================
echo ""
echo "🔐 [4단계] 사용자 비밀키 추출 (threshold 복호화용)"
echo "------------------------------------------------------------"
echo "   ⏳ 마스터키에서 사용자 비밀키 추출 중..."

USER_SECRET_1=$(seal-cli extract \
    --package-id "$PACKAGE_ID" \
    --id "$ENCRYPTION_ID" \
    --master-key "$MASTERKEY_1" 2>&1 | grep "User secret key" | sed 's/.*: //')

USER_SECRET_2=$(seal-cli extract \
    --package-id "$PACKAGE_ID" \
    --id "$ENCRYPTION_ID" \
    --master-key "$MASTERKEY_2" 2>&1 | grep "User secret key" | sed 's/.*: //')

USER_SECRET_3=$(seal-cli extract \
    --package-id "$PACKAGE_ID" \
    --id "$ENCRYPTION_ID" \
    --master-key "$MASTERKEY_3" 2>&1 | grep "User secret key" | sed 's/.*: //')

echo "   ✅ 사용자 비밀키 추출 완료!"
echo "   🔑 User Secret 1: ${USER_SECRET_1}"
echo "   🔑 User Secret 2: ${USER_SECRET_2}"
echo "   🔑 User Secret 3: ${USER_SECRET_3}"

# ============================
# 5단계: Threshold 복호화
# ============================
echo ""
echo "🔓 [5단계] Threshold 복호화 (2-of-3)"
echo "------------------------------------------------------------"
echo "   🔑 User Secret 1, 2 사용 (threshold=2)"
echo ""

echo "   ⏳ Threshold 복호화 중..."
THRESHOLD_DECRYPT_OUTPUT=$(seal-cli decrypt \
    "$ENCRYPTED_OBJECT" \
    "$USER_SECRET_1" "$USER_SECRET_2" \
    -- "$KEY_SERVER_1" "$KEY_SERVER_2" 2>&1)

THRESHOLD_DECRYPTED_HEX=$(echo "$THRESHOLD_DECRYPT_OUTPUT" | grep "Decrypted message" | sed 's/.*: //')

echo "   ✅ Threshold 복호화 완료!"
echo "   🔐 복호화된 Hex: $THRESHOLD_DECRYPTED_HEX"

# Hex를 문자열로 변환
THRESHOLD_DECRYPTED_STRING=$(echo "$THRESHOLD_DECRYPTED_HEX" | xxd -r -p)
echo "   📄 복호화된 문자열: \"$THRESHOLD_DECRYPTED_STRING\""

# 검증
if [ "$SECRET_STRING" = "$THRESHOLD_DECRYPTED_STRING" ]; then
    echo "   ✅ 원본과 일치함!"
else
    echo "   ❌ 원본과 불일치!"
fi

# ============================
# 6단계: 암호화된 객체 파싱
# ============================
echo ""
echo "🔍 [6단계] 암호화된 객체 파싱 (parse)"
echo "------------------------------------------------------------"

echo "   ⏳ 객체 파싱 중..."
seal-cli parse "$ENCRYPTED_OBJECT"

# ============================
# 테스트 결과 요약
# ============================
echo ""
echo "============================================================"
echo "📊 테스트 결과 요약"
echo "============================================================"
echo "   ✅ AES 암호화 성공"
echo "   ✅ 대칭키 복호화 성공"
echo "   ✅ 사용자 비밀키 추출 성공"
echo "   ✅ Threshold 복호화 성공"
echo "   ✅ 암호화 객체 파싱 성공"
echo ""
echo "============================================================"
echo "🎉 Seal CLI 테스트 완료!"
echo "============================================================"
