from services.identity.app.passwords import hash_password, verify_password


def test_hash_then_verify_roundtrip():
    encoded = hash_password("correct horse")
    assert encoded.startswith("pbkdf2_sha256$")
    assert verify_password("correct horse", encoded) is True


def test_verify_rejects_wrong_password():
    encoded = hash_password("correct horse")
    assert verify_password("wrong password", encoded) is False


def test_two_hashes_of_same_password_differ_by_salt():
    assert hash_password("same") != hash_password("same")


def test_verify_rejects_malformed_encoding():
    assert verify_password("anything", "not-a-valid-hash") is False
