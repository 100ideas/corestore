# 2019-07-17 @100ideas fork of `@frando/corestore`

changes:
- [`fileutils()`](https://github.com/100ideas/corestore/blob/master/browser-example.js#L261) added mime-type, file type, and file encoding detectors to make it easier for the browser to correctly parse and display various file types from the in-browser hyperdrives in corestore
	- would have been smarter to dig into the internals of hyperdrive + corestore to make them always return a `unit8` buffer for all file access, but in this case I wanted to explore how to detect different file types and content encodings
- added special choo handlers for image files. the handler decodes/reencodes the image file from hyperdrive into a `dataurl` and creates an <img src=[dataurl]/> element that displays it
- added `remark/rehast` linter/prettifier for markdown files
- experimented with setting up event listeners for each hyperdrive in the corestore, example:
	- `drive.on( 'data', () => console.log( `store:${id}::data` ) )`

todo:
- would like to use hyperdrive event listeners to trigger automatic updating of the choo UI.

![2019-07-17_frando-corestore-100ideas-fork-screenshot](/2019-07-17_frando-corestore-100ideas-fork-screenshot.png)

to try out:
```bash
git clone `https://github.com/100ideas/corestore.git corestore-playground`
cd corestore-playground

// using node v10
npm i
npm run dev
// open browser to localhost:8080
// optionally also localhost:8081
// discovery-swarm-web launches automatically to provide local archive replication

// you can try cloning my archive `dat://498427fc61bc69a2aad50c32ca926118794bd10a2f2dfc6e05a82efd3597cb2e`
// alternatively:
cd ..
mkdir corestore-dat-archive
cd corestore-dat-archive
// copy some images, markdown, exes, pdfs etc into this directory
dat share // give this a few secs, then ctrl-c
dat sync  // leave this running; paste dat address into corestore at localhost:8080
---

# @frando/corestore

> Experimental fork of [@andrewosh/corestore](https://github.com/andrewosh/corestore):
> 
> * Makes all primary resources (storage, discovery, level) pluggable to make corestore run in both node and the browser.
> * Include sensible defaults for both node and browers. Just `require('corestore')` and depending on the environment either the browser or node defaults will be used.
> * Adds support for other hypercore-based datastructures (like hyperdrives) by swapping the hypercore constructor for a factory.

Manages and seeds a library of Hypercore-based data structures (e.g. [hypercore](https://github.com/mafintosh/hypercore), [hyperdrive](https://github.com/mafintosh/hyperdrive), [hyperdb](https://github.com/mafintosh/hyperdb/) and [multifeed](https://github.com/kappa-db/multifeed)). *Note: So far only tested with hypercore and hyperdrive*.

Networking code lightly modified from [Beaker's implementation](https://github.com/beakerbrowser/beaker-core/blob/master/dat/daemon/index.js).

## Installation
```
npm i @frando/corestore --save
```

## Example

`npm run example`, and then open both [http://localhost:8080](http://localhost:8080) and [http://localhost:8081](http://localhost:8081) in the browser. You should be able to create both hyperdrives and hypercores, with persistent in-browser storage and automatically working synchronization between the two instances. The code (it's simple!) is in `/example` and has [`choo`](https://github.com/choojs/choo) as the only other dependency apart from `corestore`.

## Usage

All examples here work both in the browser and in node.

*Hypercore-only store.*
```js
let store = corestore('my-storage-dir')
await store.ready()

// Create a new hypercore, seeded by default.
let core = await store.get()
await core.ready()

// Create a new hypercore with non-default options.
let core = store.get({ valueEncoding: 'utf-8', seed: false })
await core.ready()

// Get an existing hypercore by key (will automatically replicate in the background).
let core = await store.get('my-dat-key')

// Stop seeding a hypercore by key (assuming it was already seeding).
await store.update(core.key, { seed: false })

// Delete and unseed a hypercore.
await store.delete(core.key)

// Get the metadata for a stored hypercore.
await store.info(core.key)

// Stop seeding and shut down
await store.close()

```

*A store for both hypercores and hyperdrives*

```js
let store = corestore('my-storage-dir', {
  factories: {
    hyperdrive: require('hyperdrive'),
    hypercore: require('hypercore')
  }
})

await store.ready()

const hyperdrive = await store.get({ type: 'hyperdrive' })
hyperdrive.writeFile('/foo/bar', Buffer.from('hello, world!'), (err) => {
  console.log('File was written!')
})

// Everything else works as above.
```

## API

#### `const store = corestore(path, opts)`

The `path` parameter is interpreted as a file system path in node (when using the default `random-access-file` storage), and as a namespace when running in the browser.

Options include:

* `level`: A leveldown-compliant leveldb wrapper. Default is leveldown in node, level.js in browsers.
* `storage`: A [`random-access-storage`](https://github.com/random-access-storage/) instance. Defaults to [`random-access-file`](https://github.com/random-access-file/) in node, [`random-access-web`](https://github.com/random-access-web/) in browsers.
* `swarm`: A [`discovery-swarm`](https://github.com/mafintosh/discovery-swarm). Defaults to `discovery-swarm` in node and [`discovery-swarm-web`](https://github.com/RangerMauve/discovery-swarm-web) in browsers.
* `factories`: An object of factories. Key names are types, values should be constructors for *abstract-dat* compliant data structures (see below). Example:
	```js
	const opts = {
		factories: {
			hypercore: require('hypercore'),
			hyperdrive: require('hyperdrive'),
			hypertrie: require('hypertrie')
		}
	}
  ```
* `factory`: Instead of passing an object of factories, you can also pass a `factory` callback. It will be invoked when a new data structure is to be created: `function factory (path, key, opts, store) { ... }`, where `path` is a string that should be used as storage location, `key` is the public key, `store` is a reference to the corestore and `opts` are opts that are passed with the `store.get` call (or are retrieved from the metadata db for already tracked structures). If the structure needs primary resources, a `random-access-storage` constructor is available on `store.storage(path)` and a level-db that could be [`subleveled`](https://github.com/Level/subleveldown) on `store.level`
* `network`: Network options, are passed to the `discovery-swarm` constructor. Set `network.disable` to `true` to completely disable swarming.


#### `async get([key], [opts])`
Either load a hypercore by key, or create a new one.

If a core was previously created locally, then it will be writable.

Opts can contain:

* `type: string`: The type of the structure. May be **required** when `get`ting a so-far untracked structure and using a `factories` object.
* `valueEncoding: string | codec` // Default value encoding for new hypercores.
* `seed: bool`: Seed (share) the structure in the p2p swarm.
* `sparse: bool`: Enable sparse replication by default.
* `name: string`: A name, will be stored in the metadata db.
* `description: string`
* `keyPair: { publicKey, secretKey }`

#### `async update(key, opts)`
Update the metadata associated with a hypercore. If the given hypercore has already been initialized, then its `valueEncoding` or `sparse` options will not be modified.

Updating the `seed` value will enable/disable seeding.

`opts` should match the `get` options.

#### `async info(key)`
Return the metadata associated with the specified hypercore. The metadata schema matches the `get` options.

#### `async list()`
List all hypercores being stored. The result is a `Map` of the form:
```js
Map {
  key1 => metadata1,
  key2 => metadata2,
  ...
}
```

#### `async delete(key)`
Unseed and delete the specified hypercore, if it's currently being stored.

Throws if the key has not been previously stored.

## License

MIT
