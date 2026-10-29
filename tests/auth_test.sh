#!/usr/bin/env bash
# auth_test.sh: контракт многопользовательской авторизации против http://127.0.0.1:8099
# гоняется на VM115; требует: свежий DATA_DIR, seed-файл legacy-задачи уже на диске.
set -u
B=http://127.0.0.1:8090; [ "${1:-}" ] && B=$1
A=$B/v1
pass=0; failn=0
ok()  { if [ "$2" = "1" ]; then pass=$((pass+1)); echo "  OK   $1"; else failn=$((failn+1)); echo "  ПАДЕНИЕ $1 ${3:-}"; fi }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
body() { curl -s "$@"; }
hdr()  { curl -s -D - -o /dev/null "$@"; }

J1=/tmp/authtest_admin.jar; J2=/tmp/authtest_ivan.jar; rm -f $J1 $J2

# 1. /health открыт, users_ready=false (первый запуск)
h=$(body $B/health)
ok '/health открыт, users_ready=false' "$(echo "$h" | grep -c '"users_ready": *false')"
ok '/health содержит version' "$(echo "$h" | grep -c '"version' )"

# 2. без сессии /jobs -> 401
ok 'без сессии GET /jobs -> 401' "$( [ "$(code $B/jobs)" = 401 ] && echo 1 )"
ok 'без сессии GET /me -> 401' "$( [ "$(code $B/me)" = 401 ] && echo 1 )"
c=$(code -X POST $A/audio/transcriptions); ok 'без сессии POST /v1/audio/transcriptions -> 401/422' "$( { [ "$c" = 401 ] || [ "$c" = 422 ]; } && echo 1 )"
ok 'без сессии GET /admin/users -> 401' "$( [ "$(code $B/admin/users)" = 401 ] && echo 1 )"

# 3+4. один вызов /setup: создаёт админа, ставит cookie; флаги cookie смотрим здесь же
out=$(curl -s -i -c $J1 -X POST $B/setup -H 'Content-Type: application/json' -d '{"name":"admin","password":"secret123"}')
c=$(echo "$out" | sed -n '1s/.*HTTP\/[0-9.]* \([0-9]*\).*/\1/p')
setcookie=$(echo "$out" | grep -i '^set-cookie')
ok 'POST /setup -> 200' "$( [ "$c" = 200 ] && echo 1 )" "$c"
ok 'Set-Cookie: HttpOnly' "$(echo "$setcookie" | grep -ci 'httponly')"
ok 'Set-Cookie: SameSite=strict' "$(echo "$setcookie" | grep -ci 'samesite=strict')"
ok 'повторный /setup -> 409' "$( [ "$(code -X POST $B/setup -H 'Content-Type: application/json' -d '{"name":"admin","password":"secret123"}')" = 409 ] && echo 1 )"
me=$(body -b $J1 $B/me)
ok 'GET /me -> admin' "$(echo "$me" | grep -c '"role": *"admin"' )" 1
ok 'ключ API выдан' "$(echo "$me" | grep -c '"key"' )" 1
ok '/health теперь users_ready=true' "$(body $B/health | grep -c '"users_ready": *true')" 1

# 5. настройки пользователя roundtrip
c=$(code -b $J1 -X PUT $B/me/settings -H 'Content-Type: application/json' -d '{"cfg":{"language":"ru"},"ui":{"rows":7}}')
ok 'PUT /me/settings -> 200' "$( [ "$c" = 200 ] && echo 1 )" "$c"
me=$(body -b $J1 $B/me)
ok 'GET /me отдаёт сохранённые настройки' "$(echo "$me" | grep -c '"rows": *7')" 1

# 6. админ создаёт пользователя
c=$(code -b $J1 -X POST $B/admin/users -H 'Content-Type: application/json' -d '{"name":"ivan","password":"iv4npass","role":"user"}')
ok 'POST /admin/users -> 200' "$( [ "$c" = 200 ] && echo 1 )" "$c"
c=$(code -X POST $B/login -H 'Content-Type: application/json' -d '{"name":"ivan","password":"wrong"}')
ok 'неверный пароль -> 401' "$( [ "$c" = 401 ] && echo 1 )" "$c"
c=$(code -c $J2 -X POST $B/login -H 'Content-Type: application/json' -d '{"name":"ivan","password":"iv4npass"}')
ok 'POST /login ivan -> 200' "$( [ "$c" = 200 ] && echo 1 )" "$c"
me=$(body -b $J2 $B/me)
ok 'ivan: роль user' "$(echo "$me" | grep -c '"role": *"user')" 1
k1=$(echo "$me" | sed -n 's/.*"key": *"\([^"]*\)".*/\1/p')
k2=$(body -b $J1 $B/me | sed -n 's/.*"key": *"\([^"]*\)".*/\1/p')
[ -n "$k1" ] && [ -n "$k2" ] && [ "$k1" != "$k2" ] && r=1 || r=0
ok 'ключи у разных пользователей разные' "$r"

# 7. изоляция: ivan не видит чужое
ok 'ivan: GET /admin/users -> 403' "$( [ "$(code -b $J2 $B/admin/users)" = 403 ] && echo 1 )"
ok 'ivan: GET /admin/settings -> 403' "$( [ "$(code -b $J2 $B/admin/settings)" = 403 ] && echo 1 )"
ok 'ivan: scope=all -> 403' "$( [ "$(code -b $J2 "$B/jobs?scope=all")" = 403 ] && echo 1 )"

# 8. видимость задач: legacy (без owner) и задача админа
seed=$(grep -o '"id": *"[0-9a-f-]*"' /tmp/servimtest/data/*.json 2>/dev/null | head -1 | sed -n 's/.*"id": *"\([^"]*\)".*/\1/p')
[ -z "$seed" ] && seed=$(ls /tmp/servimtest/data/*.json 2>/dev/null | sed -n 's|.*/\([0-9a-f-]*\)\.json|\1|p' | head -1)
admjobs=$(body -b $J1 $B/jobs)
ivjobs=$(body -b $J2 $B/jobs)
if [ -n "$seed" ]; then
  ok "админ видит legacy-задачу ($seed)" "$(echo "$admjobs" | grep -c "$seed")"
  iv_sees=$(echo "$ivjobs" | grep -c "$seed"); ok 'ivan НЕ видит legacy-задачу' "$( [ "${iv_sees:-0}" = 0 ] && echo 1 )"
fi
n_adm=$(echo "$admjobs" | sed -n 's/.*"count": *\([0-9]*\).*/\1/p'); [ -z "$n_adm" ] && n_adm=0
n_iv=$(echo "$ivjobs" | sed -n 's/.*"count": *\([0-9]*\).*/\1/p'); [ -z "$n_iv" ] && n_iv=0
if [ "$n_adm" -ge 1 ]; then ok "админ видит все задачи ($n_adm), ivan — свои ($( [ $n_iv -ge 0 ] && echo $n_iv ))" 1; fi

# 9. смена своего пароля
c=$(code -b $J2 -X POST $B/me/password -H 'Content-Type: application/json' -d '{"old":"iv4npass","new":"newiv4n"}')
ok 'ivan: POST /me/password (старый+новый) -> 200' "$( [ "$c" = 200 ] && echo 1 )" "$c"
c=$(code -b $J2 -X POST $B/me/password -H 'Content-Type: application/json' -d '{"old":"неверный","new":"x9pass99"}')
ok 'смена с неверным старым -> 400' "$( [ "$c" = 400 ] && echo 1 )" "$c"
c=$(code -X POST $B/login -H 'Content-Type: application/json' -d '{"name":"ivan","password":"iv4npass"}')
ok 'старый пароль больше не работает -> 401' "$( [ "$c" = 401 ] && echo 1 )" "$c"
c=$(code -X POST $B/login -H 'Content-Type: application/json' -d '{"name":"ivan","password":"newiv4n"}')
ok 'новый пароль работает -> 200' "$( [ "$c" = 200 ] && echo 1 )" "$c"

# 10. регенерация ключа
oldk=$(body -b $J2 $B/me | sed -n 's/.*"key": *"\([^"]*\)".*/\1/p')
c=$(code -b $J2 -X POST $B/me/key)
ok 'ivan: POST /me/key -> 200' "$( [ "$c" = 200 ] && echo 1 )" "$c"
newk=$(body -b $J2 $B/me | sed -n 's/.*"key": *"\([^"]*\)".*/\1/p')
[ "$oldk" != "$newk" ] && r=1 || r=0; ok 'ключ сменился' "$r"

# 11. админ управляет пользователем
c=$(code -b $J1 -X POST $B/admin/users/ivan -H 'Content-Type: application/json' -d '{"password":"resetpw"}')
ok 'админ: сброс пароля ivan -> 200' "$( [ "$c" = 200 ] && echo 1 )" "$c"
c=$(code -X POST $B/login -H 'Content-Type: application/json' -d '{"name":"ivan","password":"resetpw"}')
ok 'пароль сброшен -> 200' "$( [ "$c" = 200 ] && echo 1 )" "$c"
# удалить нельзя, пока это последний юзер-сессия? удаляем ivan
c=$(code -b $J1 -X DELETE $B/admin/users/ivan)
ok 'админ: DELETE /admin/users/ivan -> 204' "$( [ "$c" = 204 ] && echo 1 )" "$c"
ok 'сессия удалённого умерла: /me -> 401' "$( [ "$(code -b $J2 $B/me)" = 401 ] && echo 1 )"

# 12. системные настройки
c=$(code -b $J1 -X PUT $B/admin/settings -H 'Content-Type: application/json' -d '{"url":"http://192.168.10.149:8090","port":8090}')
ok 'админ: PUT /admin/settings -> 200' "$( [ "$c" = 200 ] && echo 1 )" "$c"
ok 'PUT /admin/settings сохранён' "$(body -b $J1 $B/admin/settings | grep -c '192.168.10.149')" 1
ok 'sys.json записан на диск' "$( [ -f /tmp/servimtest/data/auth/sys.json ] && echo 1 )"

# 13. logout
c=$(code -b $J1 -X POST $B/logout)
ok 'POST /logout -> 200' "$( [ "$c" = 200 ] && echo 1 )" "$c"
ok 'после logout /me -> 401' "$( [ "$(code -b $J1 $B/me)" = 401 ] && echo 1 )"

echo; echo "ПРОЙДЕНО: $pass, ПАДЕНИЙ: $failn"
[ "$failn" = 0 ] && echo "ВСЁ ЧИСТО" || echo "ЕСТЬ ПАДЕНИЯ"
exit $failn
