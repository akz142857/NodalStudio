"""Keep a disposable SQLite WAL writer alive for native file-access acceptance."""
import pathlib
import sqlite3
import tempfile


def main():
    root = pathlib.Path(tempfile.mkdtemp(prefix="nodal-sqlite-fixture-")).resolve()
    (root / "NODAL_SQLITE_FIXTURE").write_text("Disposable acceptance fixture\n")
    connection = sqlite3.connect(root / "fixture.sqlite")
    try:
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA wal_autocheckpoint=0")
        connection.execute("CREATE TABLE fixture(value)")
        connection.commit()
        connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        connection.executemany("INSERT INTO fixture VALUES (?)", [
            ("committed in WAL",), (9223372036854775807,),
        ])
        connection.commit()
        print(root, flush=True)
        input("Keep this process open through app restart; press Enter to close.\n")
    finally:
        connection.close()


if __name__ == "__main__":
    main()
