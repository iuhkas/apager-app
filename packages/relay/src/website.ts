/**
 * Anbindung an das Einsatzband der Feuerwehr-Website.
 *
 * Uebertragen wird ausschliesslich die Tatsache, dass alarmiert wurde -
 * **kein Stichwort und keine Einheit**. In einem Dorf mit zweihundert
 * Einwohnern ist schon "Wohnungsbrand" eine Angabe ueber eine bestimmte
 * Familie: wer die Sirene gehoert hat und danach die Startseite aufruft,
 * weiss sofort Bescheid.
 *
 * Der Schluessel der Website liegt nur hier auf dem Server. Die Desktop-App
 * kommt nicht direkt an die Website, sondern geht ueber den Relay - sonst
 * muesste der Schluessel auf jedem Rechner liegen, der die App benutzt.
 */

import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { FastifyBaseLogger } from 'fastify'
import type { WebsiteStatus } from '@apager/shared'

/** Basis der Strecken, ohne abschliessenden Schraegstrich. */
const API = (process.env.WEBSITE_API_URL ?? '').replace(/\/+$/, '')
const TOKEN = process.env.WEBSITE_TOKEN ?? ''
/*
 * Host-Kopfzeile, wenn die Website containerintern angesprochen wird.
 *
 * Auf dem Server liegen Relay und Website im selben Docker-Netz. Der Aufruf
 * geht deshalb direkt an den Webcontainer statt ueber die oeffentliche
 * Adresse: kein Umweg durch den Edge-Proxy, kein TLS-Handschlag, und vor
 * allem kein Basic-Auth-Schutz, der die Seite waehrend des Aufbaus
 * abschirmt. Drupal braucht dafuer aber den richtigen Host - unter dem
 * Containernamen antwortet es mit 400.
 */
const HOST = process.env.WEBSITE_HOST ?? ''
const TICKER_SECONDS = Number(process.env.WEBSITE_TICKER_SECONDS ?? 0)
const TIMEOUT_MS = 5000

export const websiteConfigured = API !== '' && TOKEN !== ''

interface Antwort {
  ok: boolean
  status: number
  text: string
}

/**
 * Eine Strecke aufrufen.
 *
 * Bewusst ueber node:http statt fetch: fetch verwirft eine mitgegebene
 * host-Kopfzeile stillschweigend (sie gilt in der Fetch-Spezifikation als
 * verboten). Containerintern kam dadurch nicht der erwartete 403, sondern
 * ein 400 - der Aufruf erreichte Drupal gar nicht erst.
 */
function ruf(weg: string, method: string, body?: string): Promise<Antwort> {
  const url = new URL(`${API}/${weg}`)
  const senden = url.protocol === 'https:' ? httpsRequest : httpRequest

  const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }
  if (HOST) headers.host = HOST
  if (body !== undefined) {
    headers['content-type'] = 'application/json'
    headers['content-length'] = String(Buffer.byteLength(body))
  }

  return new Promise<Antwort>((erfuellen, ablehnen) => {
    const anfrage = senden(url, { method, headers }, (antwort) => {
      let text = ''
      antwort.setEncoding('utf8')
      antwort.on('data', (teil: string) => {
        text += teil
      })
      antwort.on('end', () => {
        const status = antwort.statusCode ?? 0
        erfuellen({ ok: status >= 200 && status < 300, status, text })
      })
    })

    anfrage.setTimeout(TIMEOUT_MS, () => anfrage.destroy(new Error('Zeitueberschreitung')))
    anfrage.on('error', ablehnen)
    if (body !== undefined) anfrage.write(body)
    anfrage.end()
  })
}

/**
 * Band einschalten. Fehler werden protokolliert, nicht geworfen - die
 * Alarmierung hat Vorrang vor der Website.
 */
export async function startWebsiteTicker(log: FastifyBaseLogger): Promise<void> {
  if (!websiteConfigured) return

  const body: Record<string, number> = {}
  // Ohne Angabe entscheidet die Website selbst (drei Stunden).
  if (TICKER_SECONDS > 0) body.dauer = TICKER_SECONDS

  try {
    const response = await ruf('alarm', 'POST', JSON.stringify(body))
    if (!response.ok) {
      log.warn({ status: response.status }, 'website hat das einsatzband abgelehnt')
      return
    }
    log.info('website: einsatzband eingeschaltet')
  } catch (error) {
    // Website nicht erreichbar, Zertifikat abgelaufen, Zeitueberschreitung -
    // alles kein Grund, den Alarm anders zu behandeln.
    log.warn({ err: error }, 'website nicht erreichbar, einsatzband bleibt aus')
  }
}

/**
 * Band ausschalten. Hier wird der Fehler zurueckgemeldet: der Knopf in der
 * App soll sagen koennen, ob es geklappt hat.
 */
export async function stopWebsiteTicker(log: FastifyBaseLogger): Promise<WebsiteStatus> {
  if (!websiteConfigured) return { configured: false }
  try {
    const response = await ruf('entwarnung', 'POST')
    if (!response.ok) {
      log.warn({ status: response.status }, 'website hat die entwarnung abgelehnt')
      return { configured: true, error: `Website antwortete mit ${response.status}` }
    }
    log.info('website: einsatzband ausgeschaltet')
    return { configured: true, status: 'aus' }
  } catch (error) {
    log.warn({ err: error }, 'website nicht erreichbar, entwarnung nicht moeglich')
    return { configured: true, error: 'Website nicht erreichbar' }
  }
}

/**
 * Nachsehen, ob das Band gerade laeuft.
 */
export async function websiteTickerStatus(log: FastifyBaseLogger): Promise<WebsiteStatus> {
  if (!websiteConfigured) return { configured: false }
  try {
    const response = await ruf('status', 'GET')
    if (!response.ok) {
      return { configured: true, error: `Website antwortete mit ${response.status}` }
    }
    const daten = JSON.parse(response.text) as { status?: string; seit?: string; bis?: string }
    return {
      configured: true,
      status: daten.status === 'laeuft' ? 'laeuft' : 'aus',
      seit: daten.seit,
      bis: daten.bis
    }
  } catch (error) {
    log.warn({ err: error }, 'website nicht erreichbar')
    return { configured: true, error: 'Website nicht erreichbar' }
  }
}
