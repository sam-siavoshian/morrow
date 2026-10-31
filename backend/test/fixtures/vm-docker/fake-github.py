"""Fake https://github.com for the git.sh Docker proof: smart HTTP through `git http-backend`.

Every request needs Basic auth `x-access-token:<EXPECTED_TOKEN>`; each one is logged as a JSON line
to LOG with whether the credential matched (never the credential itself). Pushes are slowed down so
the scenario's agent-uid scanner has time to look at the root git processes while they run.
"""
import json
import os
import ssl
import subprocess
import sys
import time
from base64 import b64decode
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = os.environ["EXPECTED_TOKEN"]
ROOT = os.environ.get("GIT_ROOT", "/srv/git")
LOG = os.environ.get("FAKE_GH_LOG", "/var/log/fake-github.jsonl")
SLOW_SECS = float(os.environ.get("SLOW_SECS", "2"))


def log(entry):
    with open(LOG, "a") as f:
        f.write(json.dumps(entry) + "\n")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def auth(self):
        header = self.headers.get("Authorization", "")
        if not header.startswith("Basic "):
            return "missing"
        try:
            user, _, password = b64decode(header[6:]).decode().partition(":")
        except Exception:
            return "bad"
        return "ok" if user == "x-access-token" and password == TOKEN else "bad"

    def body(self):
        if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
            out = b""
            while True:
                size = int(self.rfile.readline().strip(), 16)
                if size == 0:
                    self.rfile.readline()
                    return out
                out += self.rfile.read(size)
                self.rfile.readline()
        return self.rfile.read(int(self.headers.get("Content-Length", "0")))

    def handle_any(self):
        path, _, query = self.path.partition("?")
        auth = self.auth()
        log({"method": self.command, "path": path, "query": query, "auth": auth})
        data = self.body() if self.command == "POST" else b""
        if auth != "ok":
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Basic realm="GitHub"')
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if "git-receive-pack" in path or "service=git-receive-pack" in query:
            time.sleep(SLOW_SECS)
        env = {
            "PATH": "/usr/bin:/bin",
            "GIT_PROJECT_ROOT": ROOT,
            "GIT_HTTP_EXPORT_ALL": "1",
            "PATH_INFO": path,
            "QUERY_STRING": query,
            "REQUEST_METHOD": self.command,
            "CONTENT_TYPE": self.headers.get("Content-Type", ""),
            "CONTENT_LENGTH": str(len(data)),
            "REMOTE_USER": "x-access-token",
            "REMOTE_ADDR": "127.0.0.1",
        }
        if self.headers.get("Content-Encoding"):
            env["HTTP_CONTENT_ENCODING"] = self.headers["Content-Encoding"]
        if self.headers.get("Git-Protocol"):
            env["GIT_PROTOCOL"] = self.headers["Git-Protocol"]
        out = subprocess.run(["git", "http-backend"], input=data, env=env, capture_output=True).stdout
        head, _, payload = out.partition(b"\r\n\r\n")
        if not _:
            head, _, payload = out.partition(b"\n\n")
        status = 200
        headers = []
        for line in head.decode("latin-1").splitlines():
            name, _, value = line.partition(":")
            if name.lower() == "status":
                status = int(value.strip().split()[0])
            elif name:
                headers.append((name, value.strip()))
        self.send_response(status)
        for name, value in headers:
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    do_GET = handle_any
    do_POST = handle_any


def main():
    server = ThreadingHTTPServer(("127.0.0.1", 443), Handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(sys.argv[1], sys.argv[2])
    server.socket = context.wrap_socket(server.socket, server_side=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
