import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  classifyEndpointKind,
  measureChannelSpeed,
  mergeEndpoints,
  parsePairingQrPayload,
  pickBestEndpoint
} from '../channels'
import type { VlChannelEndpoint } from '../types'

describe('VibeLink channels & pairing utilities', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('parses compact QR JSON, vibelink:// deep link, and plain URL/IP', () => {
    const compact = JSON.stringify({
      v: 1,
      h: 'HAOSHAO',
      k: 'tok_abc123',
      e: [
        { n: '内网 (WLAN)', k: 'lan', u: 'http://192.168.5.2:18990' },
        { n: '外网 · Tailscale', k: 'tailscale', u: 'http://100.98.206.126:18990' }
      ]
    })
    const parsedCompact = parsePairingQrPayload(compact)
    expect(parsedCompact.hostName).toBe('HAOSHAO')
    expect(parsedCompact.token).toBe('tok_abc123')
    expect(parsedCompact.endpoints).toHaveLength(2)
    expect(parsedCompact.endpoints[0]).toMatchObject({
      kind: 'lan',
      url: 'http://192.168.5.2:18990'
    })
    expect(parsedCompact.endpoints[1]).toMatchObject({
      kind: 'tailscale',
      url: 'http://100.98.206.126:18990'
    })

    const parsedLink = parsePairingQrPayload(
      'vibelink://pair?token=tok_link&lan=http://192.168.1.9:18990&ts=http://100.64.0.5:18990&wan=https://vl.example.com'
    )
    expect(parsedLink.token).toBe('tok_link')
    expect(parsedLink.endpoints.map((ep) => ep.kind)).toEqual(['lan', 'tailscale', 'wan'])

    const parsedPlain = parsePairingQrPayload('192.168.137.1:18990')
    expect(parsedPlain.endpoints).toEqual([
      expect.objectContaining({
        kind: 'lan',
        url: 'http://192.168.137.1:18990'
      })
    ])
  })

  it('merges incoming endpoints by normalized URL while preserving prior metrics', () => {
    const existing: VlChannelEndpoint[] = [
      {
        id: 'ch_1',
        label: '旧内网标签',
        kind: 'lan',
        url: 'http://192.168.5.2:18990/',
        priority: 10,
        enabled: true,
        lastLatencyMs: 6,
        lastDownloadMbps: 420.5,
        lastStatus: 'ok'
      }
    ]
    const merged = mergeEndpoints(existing, [
      {
        label: '内网 (以太网)',
        kind: 'lan',
        url: 'http://192.168.5.2:18990',
        iface: '以太网',
        priority: 10
      },
      {
        label: '外网 · Tailscale',
        kind: 'tailscale',
        url: 'http://100.98.206.126:18990',
        priority: 30
      }
    ])
    expect(merged).toHaveLength(2)
    expect(merged[0]).toMatchObject({
      label: '内网 (以太网)',
      iface: '以太网',
      lastLatencyMs: 6,
      lastDownloadMbps: 420.5,
      lastStatus: 'ok'
    })
    expect(merged[1].kind).toBe('tailscale')
  })

  it('picks LAN over Tailscale over WAN, and ignores disabled/failed results', () => {
    const lan: VlChannelEndpoint = {
      id: 'lan',
      label: 'LAN',
      kind: 'lan',
      url: 'http://192.168.5.2:18990',
      priority: 10,
      enabled: true
    }
    const ts: VlChannelEndpoint = {
      id: 'ts',
      label: 'Tailscale',
      kind: 'tailscale',
      url: 'http://100.98.206.126:18990',
      priority: 30,
      enabled: true
    }
    const wan: VlChannelEndpoint = {
      id: 'wan',
      label: 'WAN',
      kind: 'wan',
      url: 'https://vl.example.com',
      priority: 40,
      enabled: true
    }
    const disabledLan: VlChannelEndpoint = { ...lan, id: 'lan_off', enabled: false }

    const bestWithAll = pickBestEndpoint([
      { endpoint: wan, ok: true, latencyMs: 5 },
      { endpoint: ts, ok: true, latencyMs: 12 },
      { endpoint: lan, ok: true, latencyMs: 18 },
      { endpoint: disabledLan, ok: true, latencyMs: 1 }
    ])
    expect(bestWithAll?.endpoint.id).toBe('lan')

    const bestFailover = pickBestEndpoint([
      { endpoint: lan, ok: false, latencyMs: null, error: 'timeout' },
      { endpoint: wan, ok: true, latencyMs: 25 },
      { endpoint: ts, ok: true, latencyMs: 40 }
    ])
    expect(bestFailover?.endpoint.id).toBe('ts')

    expect(classifyEndpointKind('http://100.98.206.126:18990')).toBe('tailscale')
    expect(classifyEndpointKind('http://10.0.2.2:18990')).toBe('lan')
  })

  it('measures latency, jitter, download and upload Mbps via speedtest endpoints', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/vl/speedtest/ping')) {
        return new Response(JSON.stringify({ ok: true, service: 'vibelink', serverTs: Date.now() }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      if (url.includes('/api/vl/speedtest/download')) {
        const bytes = new Uint8Array(64 * 1024)
        return new Response(bytes, { status: 200 })
      }
      if (url.includes('/api/vl/speedtest/upload')) {
        return new Response(JSON.stringify({ ok: true, bytes: 16 * 1024 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const ep: VlChannelEndpoint = {
      id: 'ch_test',
      label: '内网测试',
      kind: 'lan',
      url: 'http://192.168.5.2:18990',
      priority: 10,
      enabled: true
    }

    const res = await measureChannelSpeed(ep, 'tok_123', {
      downloadBytes: 64 * 1024,
      uploadBytes: 16 * 1024
    })

    expect(res.ok).toBe(true)
    expect(res.latencyMs).toBeGreaterThanOrEqual(1)
    expect(res.jitterMs).toBeGreaterThanOrEqual(0)
    expect(res.downloadMbps).toBeGreaterThan(0)
    expect(res.uploadMbps).toBeGreaterThan(0)
    expect(fetchMock).toHaveBeenCalledTimes(5) // 3 pings + 1 download + 1 upload
  })

  it('prefers Primary endpoints over Standby endpoints and fails over to Standby when Primary fails', () => {
    const primaryTs: VlChannelEndpoint = {
      id: 'ep_primary_ts',
      label: 'PC 主服 · Tailscale',
      kind: 'tailscale',
      url: 'http://100.98.206.126:18990',
      serverRole: 'primary',
      nodeId: 'pc-primary',
      priority: 25,
      enabled: true
    }
    const standbyTs: VlChannelEndpoint = {
      id: 'ep_standby_ts',
      label: 'Mac mini 备服 · Tailscale',
      kind: 'tailscale',
      url: 'http://100.105.59.31:18990',
      serverRole: 'standby',
      nodeId: 'macmini-standby',
      priority: 60,
      enabled: true
    }

    const pickedWhenBothOk = pickBestEndpoint([
      { endpoint: standbyTs, ok: true, latencyMs: 5 },
      { endpoint: primaryTs, ok: true, latencyMs: 40 }
    ])
    expect(pickedWhenBothOk?.endpoint.id).toBe('ep_primary_ts')

    const pickedOnPrimaryOutage = pickBestEndpoint([
      { endpoint: primaryTs, ok: false, latencyMs: null, error: 'timeout' },
      { endpoint: standbyTs, ok: true, latencyMs: 25 }
    ])
    expect(pickedOnPrimaryOutage?.endpoint.id).toBe('ep_standby_ts')
  })
})
