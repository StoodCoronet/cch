#!/bin/bash
# Business logic smoke test for CCH server.
# Creates temporary test data, runs through key flows, then cleans up.
# Usage: ./scripts/test-business.sh [base_url]
# Env overrides: ADMIN_PASSWORD (default admin123)

set -e

BASE_URL="${1:-http://localhost:3005}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin123}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}✓ $1${NC}"; }
fail() { echo -e "${RED}✗ $1${NC}"; exit 1; }
info() { echo -e "${YELLOW}→ $1${NC}"; }

# Unique suffix for this run so repeated runs don't collide
RUN_ID="$(date +%s)"
TEST_USER="biztest_${RUN_ID}"
TEST_PASS="testpass_${RUN_ID}"
ACCOUNT_ID=""
TOKEN=""
SESSION_ID=""
BOOTSTRAP_TOKEN_ID=""

cleanup() {
    if [ -n "$ACCOUNT_ID" ]; then
        info "Cleaning up test account $ACCOUNT_ID ..."
        curl -s -X DELETE "$BASE_URL/v1/admin/accounts/$ACCOUNT_ID" \
            -H "Authorization: Bearer $ADMIN_PASSWORD" > /dev/null || true
    fi
}
trap cleanup EXIT

echo "========================================"
echo "CCH Business Test"
echo "Server: $BASE_URL"
echo "Run ID: $RUN_ID"
echo "========================================"

# 1. Health check
info "1. Health check"
HEALTH=$(curl -s -f "$BASE_URL/health" || fail "Server not reachable")
echo "$HEALTH" | grep -q '"status":"ok"' || fail "Health check failed"
pass "Server healthy"

# 2. Admin authentication
info "2. Admin authentication"
STATS=$(curl -s -f "$BASE_URL/v1/admin/stats" \
    -H "Authorization: Bearer $ADMIN_PASSWORD" || fail "Admin auth failed")
echo "$STATS" | grep -q '"accounts"' || fail "Admin stats malformed"
pass "Admin auth works"

# 3. Create account with password
info "3. Create account with password"
CREATE=$(curl -s -f -X POST "$BASE_URL/v1/admin/accounts" \
    -H "Authorization: Bearer $ADMIN_PASSWORD" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"$TEST_USER\",\"password\":\"$TEST_PASS\"}" || fail "Create account failed")
ACCOUNT_ID=$(echo "$CREATE" | python3 -c 'import sys,json;print(json.load(sys.stdin)["accountId"])')
[ -n "$ACCOUNT_ID" ] || fail "No accountId returned"
pass "Account created: $ACCOUNT_ID"

# 4. Duplicate username should fail
info "4. Duplicate username rejected"
DUP=$(curl -s -X POST "$BASE_URL/v1/admin/accounts" \
    -H "Authorization: Bearer $ADMIN_PASSWORD" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"$TEST_USER\",\"password\":\"x\"}")
echo "$DUP" | grep -q '"error":"Username already taken"' || fail "Duplicate not rejected"
pass "Duplicate username rejected"

# 5. Password login
info "5. Password login"
LOGIN=$(curl -s -f -X POST "$BASE_URL/v1/auth/password" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"$TEST_USER\",\"password\":\"$TEST_PASS\"}" || fail "Password login failed")
TOKEN=$(echo "$LOGIN" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
[ -n "$TOKEN" ] || fail "No token returned"
pass "Password login works"

# 6. Wrong password rejected
info "6. Wrong password rejected"
BAD=$(curl -s -X POST "$BASE_URL/v1/auth/password" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"$TEST_USER\",\"password\":\"wrong\"}")
echo "$BAD" | grep -q '"error":"Invalid username or password"' || fail "Wrong password not rejected"
pass "Wrong password rejected"

# 7. Create session with tag
info "7. Create session with tag"
SESSION=$(curl -s -f -X POST "$BASE_URL/v1/sessions" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"tag":"test-session","metadata":"meta","agentState":"{}"}' || fail "Create session failed")
SESSION_ID=$(echo "$SESSION" | python3 -c 'import sys,json;print(json.load(sys.stdin)["session"]["id"])')
[ -n "$SESSION_ID" ] || fail "No session id returned"
pass "Session created: $SESSION_ID"

# 8. Sessions list contains tag
info "8. Sessions list returns tag"
LIST=$(curl -s -f "$BASE_URL/v1/sessions" \
    -H "Authorization: Bearer $TOKEN" || fail "List sessions failed")
echo "$LIST" | grep -q '"tag":"test-session"' || fail "Tag not in sessions list"
pass "Sessions list returns tag"

# 9. Send plaintext message
info "9. Send plaintext message"
curl -s -f -X POST "$BASE_URL/v1/sessions/$SESSION_ID/plaintext-messages" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"role":"user","content":"hello from test"}' > /dev/null || fail "Send message failed"
pass "Message sent"

# 10. Read plaintext messages
info "10. Read plaintext messages"
MSGS=$(curl -s -f "$BASE_URL/v1/sessions/$SESSION_ID/plaintext-messages" \
    -H "Authorization: Bearer $TOKEN" || fail "Read messages failed")
echo "$MSGS" | grep -q '"content":"hello from test"' || fail "Message not found"
pass "Messages readable"

# 11. Session isPlaintext becomes true
info "11. isPlaintext flag updated"
LIST2=$(curl -s -f "$BASE_URL/v1/sessions" \
    -H "Authorization: Bearer $TOKEN" || fail "List sessions failed")
echo "$LIST2" | grep -q '"isPlaintext":true' || fail "isPlaintext not true"
pass "isPlaintext flag works"

# 12. Generate bootstrap token
info "12. Generate bootstrap token"
BOOT=$(curl -s -f -X POST "$BASE_URL/v1/bootstrap-tokens" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"label":"test-device"}' || fail "Generate token failed")
BOOTSTRAP_TOKEN_ID=$(echo "$BOOT" | python3 -c 'import sys,json;print(json.load(sys.stdin)["record"]["id"])')
echo "$BOOT" | grep -q '"connectionUrl"' || fail "No connectionUrl"
pass "Bootstrap token generated"

# 13. List tokens
info "13. List tokens"
TOKENS=$(curl -s -f "$BASE_URL/v1/bootstrap-tokens" \
    -H "Authorization: Bearer $TOKEN" || fail "List tokens failed")
echo "$TOKENS" | grep -q '"label":"test-device"' || fail "Token not in list"
pass "Token list works"

# 14. Update token label
info "14. Update token label"
curl -s -f -X PATCH "$BASE_URL/v1/bootstrap-tokens/$BOOTSTRAP_TOKEN_ID" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"label":"renamed-device"}' > /dev/null || fail "Update label failed"
pass "Token label updated"

# 15. Revoke token
info "15. Revoke token"
curl -s -f -X POST "$BASE_URL/v1/bootstrap-tokens/$BOOTSTRAP_TOKEN_ID/revoke" \
    -H "Authorization: Bearer $TOKEN" > /dev/null || fail "Revoke failed"
pass "Token revoked"

# 16. Revoked token not in active list
info "16. Revoked token filtered"
TOKENS2=$(curl -s -f "$BASE_URL/v1/bootstrap-tokens" \
    -H "Authorization: Bearer $TOKEN" || fail "List tokens failed")
echo "$TOKENS2" | grep -q '"revokedAt":null' && fail "Revoked token still active"
pass "Revoked token filtered"

# 17. Delete account cascades
info "17. Delete account"
curl -s -f -X DELETE "$BASE_URL/v1/admin/accounts/$ACCOUNT_ID" \
    -H "Authorization: Bearer $ADMIN_PASSWORD" > /dev/null || fail "Delete account failed"
ACCOUNT_ID=""
pass "Account deleted"

# 18. Old token returns 401 after account deletion
info "18. Old token returns 401 after deletion"
OLD=$(curl -s -X POST "$BASE_URL/v1/bootstrap-tokens" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"label":"x"}')
echo "$OLD" | grep -q '"error":"Account not found"' || fail "Old token not rejected"
pass "Old token correctly returns 401"

echo "========================================"
echo -e "${GREEN}All business tests passed${NC}"
echo "========================================"
