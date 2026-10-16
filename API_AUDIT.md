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

## Встроенный SwiftPlayer из APK

В APK есть отдельный `SwiftPlayerActivity` на AndroidX Media3/ExoPlayer. Он получает не только страницу источника: до запуска плеера набор парсеров AniXart извлекает прямые URL вариантов качества (Default, 360p–2160p), cookie и referer. В плеер также передаются очередь серий, выбранная серия и позиция воспроизведения. В APK видны управление скоростью, аудио/субтитрами, качеством, переходами по сериям, PiP, перемоткой и режимом кадрирования. Парсеры в этой версии APK заявлены для Kodik, Sibnet, SovetRomantica, Mail.ru, Myvi, Allvideo, AniLibria, StudioMir, VK Video, Rutube и OK.ru. Это статический разбор APK; доступность каждого источника со временем меняется.

## Выбор плеера в Kyu

Экран просмотра предлагает три режима: веб-плеер источника, встроенный плеер Kyu и системный браузер. Встроенный режим проигрывает прямые MP4/WebM/Ogg и HLS `.m3u8`; для HLS доступны варианты качества, аудиодорожки и субтитры, если они присутствуют в плейлисте. Также есть скорость 0.25×–3×, режим кадрирования (вписать/заполнить/растянуть), перемотка на 10 секунд, полноэкранный режим, PiP, авто-переход, сохранение позиции и синхронизация истории при входе. HLS поддержка поставляется локально через hls.js (лицензия рядом с файлом библиотеки в `src/vendor`).

Это ещё не полный перенос SwiftPlayer: AniXart APK сначала разбирает URL страниц провайдера в прямые потоки и их качества. В Kyu перенесены Sibnet (поиск `src` и редиректы с referer), Myvi (извлечение URL из `CreatePlayer`), Allvideo (прямые ссылки и список качеств), SovetRomantica и Rutube (HLS-варианты из master playlist), OK.ru (варианты из `data-options` для загруженных видео), AniLibria и StudioMir (потоки их API), Mail.ru (метаданные видео и cookie для прямого потока), VK Video (анонимный токен VK API и MP4-качества). Сетевой запрос Kodik, который извлечён из APK, на живом примере возвращает `validation error:: IP, deadline, sign`; одного статического URL и открытого ключа недостаточно. Kyu включает встроенный плеер для прямых файлов/HLS, выданных API или разрешённых этими парсерами, и сохраняет плеер источника для страниц Kodik и прочих неразобранных iframe.
