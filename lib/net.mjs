import http from 'node:http'
import https from 'node:https'
import dns from 'node:dns'
import net from 'node:net'

const blocked = new net.BlockList()
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]])
  blocked.addSubnet(a, p, 'ipv4')
for (const [a, p] of [['::', 96], ['64:ff9b::', 96], ['fec0::', 10], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]])
  blocked.addSubnet(a, p, 'ipv6')

export const isPrivate = address => {
  const v = net.isIP(address)
  if (v === 0) return true
  const mapped = v === 6 && address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1]
  if (mapped) return isPrivate(mapped)
  if (v === 6 && /^::ffff:/i.test(address)) return true
  return blocked.check(address, v === 6 ? 'ipv6' : 'ipv4')
}

const privateError = () => Object.assign(new Error('site resolves to a private address'), { code: 'EPRIVATE' })

export const publicOnly = (host, options, cb) => {
  if (typeof options === 'function') [cb, options] = [options, {}]
  const opts = typeof options === 'number' ? { family: options } : { ...options }
  dns.lookup(host, { ...opts, all: true }, (err, list) => {
    if (err) return cb(err)
    if (!list.length || list.some(a => isPrivate(a.address))) return cb(privateError())
    if (opts.all) cb(null, list)
    else cb(null, list[0].address, list[0].family)
  })
}

export const request = (url, { timeoutMs = 15000, maxBytes = 0, headers = {}, lookup = publicOnly } = {}) =>
  new Promise((resolve, reject) => {
    const u = new URL(url)
    const host = u.hostname.replace(/^\[|\]$/g, '')
    if (lookup === publicOnly && net.isIP(host) && isPrivate(host)) return reject(privateError())
    const lib = u.protocol === 'https:' ? https : http
    const req = lib.get(u, { lookup, headers, signal: AbortSignal.timeout(timeoutMs) }, res => {
      const done = body => resolve({ status: res.statusCode, body })
      if (!maxBytes || res.statusCode !== 200) {
        res.destroy()
        return done(null)
      }
      if (Number(res.headers['content-length']) > maxBytes) {
        res.destroy()
        return reject(new Error('too large'))
      }
      const chunks = []
      let size = 0
      res.on('data', c => {
        size += c.length
        if (size > maxBytes) {
          res.destroy()
          reject(new Error('too large'))
        } else chunks.push(c)
      })
      res.on('end', () => done(Buffer.concat(chunks).toString('utf8')))
      res.on('error', reject)
      res.on('close', () => res.complete || reject(new Error('aborted')))
    })
    req.on('error', reject)
  })
