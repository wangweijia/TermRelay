import sys

if sys.platform != "linux":
    raise SystemExit("TermRelay Linux 需要 Ubuntu / Xubuntu；macOS 请使用 apps/mac")

from .app import main

raise SystemExit(main())
