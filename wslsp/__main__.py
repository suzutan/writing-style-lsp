"""python3 -m wslsp lint <paths> / python3 -m wslsp serve"""
import sys


def main() -> int:
    if len(sys.argv) >= 2 and sys.argv[1] == "serve":
        from .server import main as serve_main
        return serve_main()
    if len(sys.argv) >= 2 and sys.argv[1] == "lint":
        from .cli import main as cli_main
        return cli_main(sys.argv[2:])
    print("usage: python3 -m wslsp {lint <paths...> | serve}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
