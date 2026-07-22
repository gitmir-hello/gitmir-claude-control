#!/bin/bash
# Двойной клик по этому файлу в Finder запускает Claude Control.
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

URL="http://localhost:4599"

# Если сервер уже поднят — просто открываем браузер и выходим.
if curl -s "$URL/api/ping" >/dev/null 2>&1; then
  open "$URL"
  exit 0
fi

# Иначе запускаем сервер (он сам откроет браузер).
exec node server.js
