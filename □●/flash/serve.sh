#!/usr/bin/bash

cd $(dirname $0)/..
#python3 -m http.server

PORT=${PORT:-8000}

echo "http://localhost:$PORT/web-app/"
# Cache-Control: no-cache, the browser asks for every file again (without it, it keeps e.g. an old index.js for a while)
(trap 'kill 0' SIGINT; python3 - $PORT <<'EOF' & wait
import http.server, sys

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

http.server.test(Handler, port=int(sys.argv[1]))
EOF
)

#(trap 'kill 0' SIGINT; python3 -m http.server & ssh -N -R 8000:localhost:8000 pi@ehx.spdns.org & wait)
