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

import type { FastifyBaseLogger } from 'fastify'
import type { WebsiteStatus } from '@apager/shared'

/** Basis der Strecken, ohne abschliessenden Schraegstrich. */
const API = (process.env.WEBSITE_API_URL ?? '').replace(/\/+$/, '')
const TOKEN = process.env.WEBSITE_TOKEN ?? ''
const TICKER_SECONDS = Number(process.env.WEBSITE_TICKER_SECONDS ?? 0)
const TIMEOUT_MS = 5000

export const websiteConfigured = API !== '' && TOKEN !== ''

async function ruf(
  weg: string,
  init: RequestInit & { method: string }
): Promise<Response> {
  return fetch(`${API}/${weg}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(init.headers ?? {})
    },
    signal: AbortSignal.timeout(TIMEOUT_MS)
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
    const response = await ruf('alarm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
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
    const response = await ruf('entwarnung', { method: 'POST' })
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
    const response = await ruf('status', { method: 'GET' })
    if (!response.ok) {
      return { configured: true, error: `Website antwortete mit ${response.status}` }
    }
    const daten = (await response.json()) as { status?: string; seit?: string; bis?: string }
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
