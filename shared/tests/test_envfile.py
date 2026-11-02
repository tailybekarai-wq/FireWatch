from pathlib import Path

from firewatch_shared.envfile import load_env_files, parse_env_text


def test_parse_handles_quotes_comments_and_export() -> None:
    text = """
# comment
A=1
B="two words"
export C='three'
EMPTY=
not a pair
URL=postgresql://u:p@h/db?sslmode=require&x=y
"""
    assert parse_env_text(text) == {
        "A": "1",
        "B": "two words",
        "C": "three",
        "EMPTY": "",
        "URL": "postgresql://u:p@h/db?sslmode=require&x=y",
    }


def test_load_does_not_override_and_respects_order(tmp_path: Path) -> None:
    first = tmp_path / ".env.local"
    second = tmp_path / ".env"
    first.write_text("A=from_local\nB=from_local\n", encoding="utf-8")
    second.write_text("B=from_env\nC=from_env\n", encoding="utf-8")
    environ = {"A": "from_process"}

    loaded = load_env_files([first, second, tmp_path / "missing"], environ)

    assert loaded == [first, second]
    assert environ == {"A": "from_process", "B": "from_local", "C": "from_env"}
