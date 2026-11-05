"""Robot key, EIP-191 helpers, nonces and registry digests."""
from __future__ import annotations

from eth_account import Account
from eth_account.messages import encode_defunct
from eth_utils import keccak

ANCHOR_TYPEHASH = keccak(b"BLACKBOX_ANCHOR_V1")
CLOSE_TYPEHASH = keccak(b"BLACKBOX_CLOSE_V1")


def _b32(hex_or_bytes) -> bytes:
    if isinstance(hex_or_bytes, bytes):
        b = hex_or_bytes
    else:
        b = bytes.fromhex(hex_or_bytes[2:] if hex_or_bytes.startswith("0x") else hex_or_bytes)
    if len(b) != 32:
        raise ValueError("expected 32 bytes")
    return b


def _word_uint(n: int) -> bytes:
    return int(n).to_bytes(32, "big")


def _word_addr(addr: str) -> bytes:
    return bytes(12) + bytes.fromhex(addr[2:])


def checkpoint_nonce(mission_id: str, obs_hash: str, checkpoint: int) -> str:
    """nonce = keccak256(abi.encode(bytes32 missionId, bytes32 obsHash, uint256 checkpoint)).

    The PRD's keccak256(obs_hash, seq) plus the mission id, so a signed answer
    for an identical crop in an earlier mission cannot be replayed.
    """
    return "0x" + keccak(_b32(mission_id) + _b32(obs_hash) + _word_uint(checkpoint)).hex()


def expected_echo(nonce: str, hex_len: int) -> str:
    return "0x" + nonce[2:2 + hex_len]


def anchor_digest(chain_id: int, registry: str, mission_id: str, count: int, head: str, index_root: str) -> bytes:
    return keccak(
        ANCHOR_TYPEHASH + _word_uint(chain_id) + _word_addr(registry) + _b32(mission_id)
        + _word_uint(count) + _b32(head) + _b32(index_root)
    )


def close_digest(chain_id: int, registry: str, mission_id: str, count: int, head: str, index_root: str,
                 trajectory_hash: str) -> bytes:
    return keccak(
        CLOSE_TYPEHASH + _word_uint(chain_id) + _word_addr(registry) + _b32(mission_id)
        + _word_uint(count) + _b32(head) + _b32(index_root) + _b32(trajectory_hash)
    )


def recover_text(text: str, signature: str) -> str:
    """EIP-191 personal_sign recovery over a UTF-8 text message (0G TEE signatures)."""
    return Account.recover_message(encode_defunct(text=text), signature=signature)


def recover_hash(digest_hex: str, signature: str) -> str:
    """EIP-191 recovery where the signed message is the 32 raw bytes of a hash."""
    return Account.recover_message(encode_defunct(primitive=_b32(digest_hex)), signature=signature)


class RobotKey:
    """The robot's own secp256k1 key. It never leaves the adapter process."""

    def __init__(self, private_key: str):
        self._acct = Account.from_key(private_key)

    @classmethod
    def generate(cls) -> "RobotKey":
        return cls(Account.create().key.hex())

    @property
    def address(self) -> str:
        return self._acct.address

    def sign_digest(self, digest: bytes) -> str:
        sig = self._acct.sign_message(encode_defunct(primitive=digest)).signature.hex()
        return sig if sig.startswith("0x") else "0x" + sig
