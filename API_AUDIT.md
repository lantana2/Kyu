# Сверка API AniXart APK 10.0 с Kyu

APK исследован статически: маршруты извлечены из `classes*.dex`; APK не запускался. База API в APK и Kyu — `api-s.anixsekai.com`. Маршрутная строка подтверждает существование ручки, но сама по себе не раскрывает HTTP-метод, тело запроса, права доступа и модель ответа.

## Подключено в Kyu 1.0.3

Новые маршруты из APK подключены через IPC в `main.js` и `preload.js`, а пользовательские экраны доступны в интерфейсе:

| Возможность | Маршруты |
|---|---|
| Входящие/исходящие запросы в друзья | `/profile/friend/requests/in/{page}`, `/profile/friend/requests/out/{page}` |
| Отправка/принятие, отмена и скрытие запроса; удаление друга | `/profile/friend/request/send/{id}`, `/profile/friend/request/remove/{id}`, `/profile/friend/request/hide/{id}`, `/friend/delete/{id}` |
| Чёрный список | `/blocklist/all/{page}`, `/blocklist/add/{id}`, `/blocklist/remove/{id}` |
| Центр уведомлений | `/notification/all/{page}`, `/notification/{articles,episodes,friends,releaseComments,article/comments,release/all,related/release}/{page}`, `/notification/read` |
| Общая лента и обновления серий релиза | `/latest/all/{page}`, `/updates/{releaseId}/{page}` |
| Подписчики канала | `/channel/{c_id}/subscribers/{page}` |
| Репосты статьи | `/article/reposts/{a_id}/{page}` |
| Видео и категории видео релиза | `/video/release/{releaseId}`, `/video/release/{releaseId}/{page}`, `/video/release/{releaseId}/category/{categoryId}/{page}`, `/video/release/categories` |

Входящие запросы можно принять через доступную в APK ручку `friend/request/send`; скрытие и отмена используют отдельные маршруты из APK. Проверка реальных ответов требует входа в аккаунт AniXart.

## Ещё обнаружено, пока не перенесено

APK также содержит апелляции к видео: `/video/appeal/profile/{page}`, `/video/appeal/profile/last`, `/video/appeal/add`, `/video/appeal/delete/{appealId}`. Форма отправки апелляции пока не перенесена: для неё нужно разобрать точное тело запроса.

Настройки и удаление уведомлений включают `/notification/my`, `/notification/status/edit`, `/notification/type/edit`, `/notification/release/type/{releaseId}`, `/notification/release/type/edit`, `/notification/related/release/edit`, `/notification/selected/releases/edit`, а также несколько `notification/*/delete/{id}`. Они не включены в экран уведомлений, пока не разобраны схемы форм и семантика параметров.

## О блокировке видеорекламы

Kyu блокирует известные рекламные домены на уровне `webRequest`, а также URL с явными VAST/преролл-маркерами. Если рекламный ролик отдаётся с того же адреса/CDN, что и видео, доменный блокировщик не может отличить их без сетевого журнала конкретного плеера; в таком случае нужно добавить точный рекламный запрос, не блокируя видеопоток.
