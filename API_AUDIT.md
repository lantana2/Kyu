# Сверка API AniXart с APK 10.0

APK из рабочей папки исследован статически: извлечены DEX-файлы, строки URL и шаблоны маршрутов. Приложение не запускалось. Домен API в APK — `api-s.anixsekai.com`, как и в Kyu.

## Уже используется в Kyu

Kyu уже вызывает основные маршруты каталога и поиска (`filter`, `search/releases`, `search/profiles`), карточки релиза и серий, авторизацию, списки, избранное, историю, отметки серий, оценки, профиль, друзей, каналы, статьи, ленту, комментарии и настройки профиля. Их обработчики находятся в `main.js` и соответствуют мосту в `preload.js`.

## Найдено в APK, но пока не подключено в Kyu

| Область | Найденные шаблоны маршрутов |
|---|---|
| Запросы в друзья | `/friend/requests/in/{page}`, `/friend/requests/out/{page}`, `/friend/request/send/{id}`, `/friend/request/remove/{id}`, `/friend/request/hide/{id}`, `/friend/delete/{id}` |
| Чёрный список | `/block/all/{page}`, `/blocklist/add/{id}`, `/blocklist/remove/{id}` |
| Уведомления | `/notification/my`, `/notification/release/all/{page}`, `/notification/status/edit`, `/notification/type/edit`, `/notification/related/release/edit` |
| Обновления серий | `/updates/{releaseId}/{page}`, `/latest/all/{page}` |
| Каналы и статьи | `/channel/{c_id}/subscribers/{page}`, `/article/comments/{page}`, `/reposts/{a_id}/{page}` |
| Видео релизов | `/video/release/{releaseId}`, `/video/release/{releaseId}/{page}`, `/video/release/{releaseId}/category/{categoryId}/{page}`, `/video/appeal/profile/{page}` |

Строка в DEX подтверждает наличие шаблона, но не его HTTP-метод, тело запроса, параметры авторизации и формат ответа. Перед добавлением любого маршрута нужно сверить его контракт; один лишь путь недостаточен для безопасной реализации. Также найденные внутренние и модераторские маршруты не включены в список пользовательских функций.

## Разумный следующий этап

Начать с запросов в друзья и чёрного списка: это самостоятельные функции профиля с ясным пользовательским результатом. Для них сначала нужно подтвердить контракт на тестовом аккаунте, затем добавить IPC-мост и UI. Уведомления и загрузку видео лучше разбирать отдельными этапами.
