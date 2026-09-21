# aPager Monitor

Desktop-Begleiter für Windows und macOS, der Alarme aus der
**aPager-PRO-Smart-Home-Schnittstelle** (Allgemeine Webhooks) entgegennimmt,
sie als Vollbild-Alarm anzeigt und dauerhaft protokolliert.

> ⚠️ Kein Ersatz für die Alarmierung. Die Kette hängt am Handy (Netz, Akku,
> Hintergrundausführung). Die App zeigt deshalb dauerhaft ihren Verbindungsstatus.

## Aufbau

```
Handy (aPager PRO, Android)
   │  HTTP GET/POST + Auth-Header   (Einheit + Stichwort)
   ▼
packages/relay      Fastify-Dienst auf dem Server, schreibt alarms.jsonl
   │  WebSocket (von der App ausgehend → keine Portfreigabe am Rechner nötig)
   ▼
packages/desktop    Electron-App (Tray + Alarmfenster), Windows + macOS
```

`packages/shared` enthält die gemeinsamen Typen und die Normalisierung der
Webhook-Felder (akzeptiert u. a. `unit`/`einheit` und `keyword`/`stichwort`,
weil die Parameternamen in aPager frei benennbar sind).

Alternativ kann die App ohne Relay arbeiten: der eingebaute **LAN-Listener**
nimmt den Webhook direkt an, solange das Handy im selben Netz ist.

## Alarm-Log

Der Relay schreibt jeden angenommenen Alarm als eine Zeile nach
`$DATA_DIR/alarms.jsonl` — unabhängig davon, ob gerade eine App läuft. Damit
ist die Einsatzhistorie auch dann vollständig, wenn der Rechner aus war.

- Nach einer Downtime lädt die App über `GET /alarms` nach. Alarme, die älter
  als fünf Minuten sind, landen still in der Historie und reißen den
  Alarmbildschirm **nicht** mehr auf (aPager sendet keine Entwarnung).
- `LOG_RETENTION_DAYS` kappt das Log beim Start; `0` bedeutet: nichts verfällt,
  geloescht wird von Hand.
- Die App haelt nur die letzten 500 Einsaetze als lokalen Zwischenspeicher und
  exportiert sie als CSV (Semikolon-getrennt, mit BOM für Excel).

## Entwicklung

```bash
npm install

# Relay lokal
INGEST_TOKEN=test-ingest CLIENT_TOKEN=test-client npm run dev:relay

# Desktop-App
npm run dev:desktop
```

Typprüfung über alle Pakete: `npm run typecheck`

## Hintergrundbetrieb und Autostart

Die App ist als Tray-Begleiter gebaut: Sie startet ohne Fenster, das Schliessen
des Fensters beendet sie nicht, und nur ein Alarm holt sie nach vorn.

- **macOS:** `LSUIElement` ist gesetzt, die App laeuft also als Agent ohne
  Dock-Icon und ohne Eintrag im App-Umschalter. Sobald ein Fenster gebraucht
  wird (Alarm oder Tray-Klick), blendet sie das Dock-Icon selbst ein.
- **Autostart** aktivierst du in den Einstellungen. Registriert wird der Start
  mit dem Argument `--hidden`; zusammen mit `wasOpenedAtLogin` erkennt die App
  den Login-Start und bleibt dann garantiert unsichtbar.
- Ohne Konfiguration zeigt sie beim **manuellen** Start das Fenster, damit man
  Relay-URL und Token eintragen kann - beim Autostart auch dann nicht.

## Pakete bauen

```bash
npm run package:mac -w @apager/desktop   # dmg + zip
npm run package:win -w @apager/desktop   # NSIS-Installer
```

Für die Verteilung an Dritte: macOS braucht Developer-ID-Signatur +
Notarisierung, Windows ein Code-Signing-Zertifikat — sonst blocken Gatekeeper
bzw. SmartScreen den Start.

## Relay deployen (Hetzner)

DNS-A-Record der Domain auf den Server zeigen lassen, dann:

```bash
git clone <dieses Repo> && cd apager-app/deploy
cp .env.example .env         # beide Tokens setzen
docker network create edge   # einmalig, falls noch nicht vorhanden
docker compose up -d --build
```

HTTPS terminiert der gemeinsame Edge-Proxy des Servers (Caddy in `/opt/edge`),
weil dort mehrere Domains auf denselben Ports liegen. Er holt das Zertifikat
automatisch und erreicht den Relay über das externe Docker-Netzwerk `edge`
unter dem Namen `apager-relay`; der Relay selbst lauscht nur intern auf Port
8080. Die Domain steht in `/opt/edge/sites/apager.caddy`.

Das Alarm-Log liegt als Bind-Mount unter `DATA_HOST_DIR` (Standard
`/opt/apager/data`). Tokens erzeugen z. B. mit `openssl rand -hex 24`.

| Endpunkt | Auth | Zweck |
| --- | --- | --- |
| `GET\|POST /hook` | Header `INGEST_HEADER: INGEST_TOKEN` | Webhook-Ziel für aPager PRO |
| `GET\|POST /hook/<INGEST_TOKEN>` | Token im Pfad | Rückfallebene ohne Header |
| `GET /alarms?limit=&since=` | Header `x-apager-client-token` | Historie (auch für Auswertungen) |
| `GET /ws?token=<CLIENT_TOKEN>` | Query-Token | WebSocket für die Desktop-App |
| `GET /health` | – | Status, verbundene Clients |

Identische Alarme (mehrere Handys derselben Einheit) werden innerhalb von
`DEDUPE_WINDOW_SECONDS` zu einem Einsatz zusammengefasst.

## Konfiguration in aPager PRO

Einstellungen → Smart Home → Webhooks → Allgemeiner Webhook:

- **URL:** `https://relay.example.de/hook`
- **Methode:** POST (JSON) oder GET (Query-Parameter) — beides wird unterstützt
- **Header:** `x-apager-token` = der Wert aus `INGEST_TOKEN`
- Schalter für Einheitenkennung und Stichwortübertragung aktivieren
- Mit dem Test-Button prüfen; der Relay loggt jeden Request

Webhooks werden von aPager nur bei echten Alarmen ausgelöst, nicht bei
Info-/Status-Meldungen.

## Datenschutz

Einheit und Stichwort liegen im Alarm-Log des Relays (`alarms.jsonl`, wird
standardmaessig nicht automatisch geloescht) und als Zwischenspeicher der
letzten 500 Einsaetze lokal in `history.json` im Benutzerprofil.

## Offen / nächste Schritte

- Einsatzadresse, Meldertext und Karte: dafür reicht die Smart-Home-Schnittstelle
  nicht, es braucht eine zweite Quelle (FE2-Webhook, Alamos-Cloud-API oder
  Alarm-Mail per IMAP).
- Code-Signing/Notarisierung und Auto-Update sind noch nicht eingerichtet.
