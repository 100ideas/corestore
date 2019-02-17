const p = require('path')

const fs = require('fs-extra')
const level = require('level')
const hypercore = require('hypercore')
const crypto = require('hypercore/lib/crypto')
const datEncoding = require('dat-encoding')
const mkdirp = require('mkdirp')
const LRU = require('lru')

const Replicator = require('./lib/replicator.js')
const messages = require('./lib/messages.js')

module.exports = Corestore

function Corestore (dir, opts) {
  if (!(this instanceof Corestore)) return new Corestore(dir, opts)
  opts = opts || {}
  this._opts = opts

  this.dir = dir
  this._root = p.join(dir, 'cores')

  if (!(opts.network && opts.network.disable)) {
    this._replicator = Replicator(this, opts.network)
  } else {
    this._noNetwork = true
  }

  // Set in ready.
  this._metadata = null
  this.coresByKey = new LRU(opts.cacheSize || 50)
  this.coresByDKey = new LRU(opts.cacheSize || 50)
  this.coresByKey.on('evict', ({ value: core }) => {
    let dkey = ensureString(core.discoveryKey)
    this.coresByDKey.remove(dkey)
    core.close()
  })

  this._opened = false

  this._ready = new Promise(async (resolve, reject) => {
    mkdirp(dir, async err => {
      if (err) return reject(err)
      this._metadata = level(p.join(dir, 'metadata'), {
        keyEncoding: 'utf-8',
        valueEncoding: 'binary'
      })
      try {
        await this._loadAll()
        this._opened = true
        return resolve()
      } catch (err) {
        return reject(err)
      }
    })
  })

  this.ready = cb => {
    if (!cb) return this._ready
    this._ready.then(() => {
      return cb()
    }).catch(err => {
      return cb(err)
    })
  }
}

Corestore.prototype._path = function (key) {
  return p.join(this._root, key)
}

Corestore.prototype._loadAll = async function () {
  let cores = await this.list()
  let keys = Object.keys(cores)
  for (var i = 0; i < keys.length; i++) {
    let key = keys[i]
    let meta = cores[key]
    await this._create(key, meta)
  }
}

Corestore.prototype._create = function (key, opts) {
  opts = opts || {}

  let keyString = ensureString(key)
  let core = hypercore(this._path(keyString), key, opts)

  this.coresByKey.set(keyString, core)

  let ready = core.ready.bind(core)
  core.ready = (cb) => {
    return new Promise((resolve, reject) => {
      ready(err => {
        if (err) return reject(err)
        this.coresByDKey.set(ensureString(core.discoveryKey), core)
        this._metadata.put(ensureString(core.key), messages.Core.encode(opts), err => {
          if (err) return reject(err)
          if (opts.seed) {
            this._seed(core)
          }
          return resolve()
        })
      })
    }).then(() => {
      if (cb) return cb()
    }).catch(err => {
      if (cb) return cb(err)
    })
  }

  return core
}

Corestore.prototype._seed = function (core) {
  if (!this._noNetwork) {
    this._replicator.add(core)
  }
}

Corestore.prototype._unseed = function (core) {
  if (!this._noNetwork) {
    this._replicator.remove(core)
  }
}

Corestore.prototype.info = async function (key) {
  key = ensureString(key)
  try {
    let value = await this._metadata.get(key)
    let decoded = messages.Core.decode(value)
    return decoded
  } catch (err) {
    if (err.notFound) return null
    throw err
  }
}

Corestore.prototype.get = function (key, opts) {
  if (typeof key === 'object' && !(key instanceof Buffer)) {
    opts = key
    key = null
  }
  opts = opts || {}
  opts.seed = opts.seed !== undefined ? opts.seed : true
  opts.sparse = opts.sparse !== undefined ? opts.sparse : true
  if (!key) opts.valueEncoding = opts.valueEncoding || 'binary'

  if (key) {
    let keyString = ensureString(key)
    let existing = this.coresByKey.get(keyString)
    if (existing) return existing
  } else {
    let { publicKey, secretKey } = crypto.keyPair()
    opts.secretKey = secretKey
    opts.writable = true
    key = publicKey
  }

  let core = this._create(key, opts)
  opts.writable = core.writable

  return core
}

Corestore.prototype.update = async function (key, opts) {
  let keyString = ensureString(key)
  let existing = this.coresByKey.get(keyString)
  if (!existing) throw new Error('Updating a nonexistent core')

  let info = await this.info(key)

  if (opts.seed !== undefined && !opts.seed) {
    await this._unseed(existing)
  }

  Object.assign(info, opts)
  this._metadata.put(keyString, messages.Core.encode(info))
}

Corestore.prototype.delete = async function (key) {
  key = ensureString(key)
  let info = await this.info(key)

  if (!info) throw new Error('Cannot delete a nonexistent key')
  let core = this.coresByKey.get(key)
  if (!core) throw new Error('Core was not initialized correctly')

  if (info.seed) {
    await this._unseed(core)
  }

  await this._metadata.del(key)
  await fs.remove(this._path(key))

  this.coresByKey.remove(key)
  this.coresByDKey.remove(ensureString(core.discoveryKey))
}

Corestore.prototype.list = async function () {
  return new Promise((resolve, reject) => {
    let result = new Map()
    let stream = this._metadata.createReadStream()
    stream.on('data', ({ key, value }) => {
      result.set(key, messages.Core.decode(value))
    })
    stream.on('end', () => {
      return resolve(result)
    })
    stream.on('error', err => {
      return reject(err)
    })
  })
}

Corestore.prototype.close = async function () {
  let self = this
  if (!this._opened) return
  let tasks = [self._metadata.close()]
  if (self._replicator) tasks.push(self._replicator.stop())
  return Promise.all(tasks)
}

function ensureString (key) {
  return datEncoding.toStr(key)
}
