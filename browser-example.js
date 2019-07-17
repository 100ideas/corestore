const Corestore = require('./browser')
// var html = require('choo/html')
var raw = require('nanohtml/raw')
var html = require('nanohtml')
var choo = require('choo')
const hyperdrive = require('hyperdrive')
const hypercore = require('hypercore')
const factories = { hyperdrive, hypercore }
const _ = require( 'lodash' );
const codecs = require('codecs')
const identify = require('identify-filetype')
// const mime = require('mime')
const mime = require('mime/lite');

renderApp()

function makeStore (name) {
  const store = Corestore(name, { factories })
  return store
}

function renderApp () {
  var app = choo()
  app.use(uiStore)
  app.route('/', mainView)
  app.mount('body')
}

function addHyperListeners( store, key, id = 'missing' ) {
  store.get( key ).then( drive => {
    drive.on( 'append', () => console.log( `store:${id}::append` ) )
    drive.on( 'data', () => console.log( `store:${id}::data` ) )
    drive.on( 'download', () => console.log( `store:${id}::download` ) )
    drive.on( 'upload', () => console.log( `store:${id}::upload` ) )
    drive.on( 'sync', () => console.log( `store:${id}::sync` ) )
    drive.on( 'close', () => console.log( `store:${id}::close` ) )  
  })
}

function uiStore (state, emitter) {
  state.list = {}
  state.data = {}
  state.ui = {}

  const store = makeStore('store')
  store.ready()
    .then( update )
    .then(
      store.list().then( storeList => {
        console.log(storeList)
        let keys = [...storeList.keys()]
        console.log( keys[ 0 ] )
        store.info(keys[0]).then(console.log)
        return keys
      })
      .then( keys => keys.map( ( key, idx ) => addHyperListeners( store, key, idx ) ) )
    )

  emitter.on('core:add', onadd)
  emitter.on('hyperdrive:writeFile', onwritefile)
  emitter.on('hypercore:append', onappend)
  emitter.on('ui:open', onopen)

  async function onopen (key) {
    state.ui.open = key
    render()
    const info = state.list[key]
    if (!info) return
    switch (info.type) {
      case 'hyperdrive': return readHyperdrive(key)
      case 'hypercore': return readHypercore(key)
    }
  }

  async function onadd (opts) {
    await store.ready()
    if (!opts.key) opts.key = undefined
    let core = await store.get(opts.key, { type: opts.type })
    await core.ready()
    update()
  }

  async function update () {
    await store.ready()
    let list = await store.list()
    let oldListKeys = _.keys(state.list)
    state.list = {}
    for (let [key, info] of list) {
      info.key = hex(info.key)
      info.discoveryKey = hex(info.discoveryKey)
      state.list[key] = info
    }
    let changes = _.difference(_.keys(list), oldListKeys)
    console.log('update - changed keys: ', changes )
    render()
  }

  async function readHyperdrive (key) {
    state.data[key] = {}
    const drive = await store.get(key)
    await drive.ready()
    const meta = {
      version: drive.version,
      byteLength: (drive.content ? drive.content.byteLength : 0) + (drive.metadata ? drive.metadata.byteLength : 0),
      writable: drive.writable
    }
    state.list[key].meta = meta
    drive.readdir('/', (err, list) => {
      if (err) throw err
      if (!list.length) return
      list.forEach(path => drive.readFile(path, done(path)))
      function done (path) {
        return (err, data) => {
          if (err) throw err
          // state.data[key][path] = data.toString()  //BUG toString() messes up binary files (imgs)
          state.data[key][path] = data
          render()
        }
      }
    })
  }

  async function readHypercore (key) {
    state.data[key] = []
    const core = await store.get(key)
    await core.ready()
    const meta = {
      length: core.length,
      byteLength: core.byteLength,
      writable: core.writable
    }
    state.list[key].meta = meta
    render()
    const rs = core.createReadStream()
    rs.on('data', d => state.data[key].push(d.toString())) //BUG toString() messes up binary files (imgs)
    rs.on('end', () => render())
  }

  async function onwritefile ({ key, path, data }) {
    const core = await store.get(key)
    core.writeFile(path, Buffer.from(data), (err) => {
      if (err) console.log('write file error', err)
      readHyperdrive(key)
    })
  }

  async function onappend ({ key, data }) {
    const core = await store.get(key)
    core.append(Buffer.from(data), (err) => {
      if (err) console.log('append error', err)
      readHypercore(key)
    })
  }

  function render () {
    console.log('render', state)
    emitter.emit('render')
  }
}

function mainView (state, emit) {
  let options = ['hyperdrive', 'hypercore']
  return html`
    <body>
      <h1>${state.title}</h1>
      <main>
        <div class="core-select">
          ${form()}
          ${list()}
        </div>
        ${open()}
        <img src='fillmurry100.png' style="position:absolute; left:0; bottom:0;"/>
      </main>
    </body>
  `

  function form () {
    return html`
      <form onsubmit=${onsubmit}>
        <p><em>Paste a key to add an existing hypercore or hyperdrive. <br/>Leave field empty and click 'Create' to create a new hypercore or hyperdrive.</em></p>
        <input type="text" name="key" placeholder="Paste key to add an existing archive" style="width: 300px" />
        <select name="type">
          ${options.map(o => html`<option value=${o}>${o}</option>`)}
        </select>
        <button type="submit">Create</button>
      </form>
    `
    function onsubmit (e) {
      emit('core:add', formData(e))
    }
  }

  function list () {
    if (!state.list || !Object.keys(state.list).length) return
    return html`
      <ul class="core-list">
        ${Object.values(state.list).map(item)}
      </ul>`
    function item ({ key, type }) {
      const selected = key === state.ui.open
      const cls = selected ? 'active' : 'dis'
      return html`
        <li class=${cls}>
          <a href="#" onclick=${open}><strong>${type}</strong> ${key}</a>
        </li>
      `
      function open (e) {
        e.preventDefault()
        emit('ui:open', key)
      }
    }
  }

  function open () {
    const key = state.ui.open
    if (!key) return 'nothing open'
    const info = state.list[key]
    const data = state.data[key]
    const writable = info.meta && info.meta.writable
    const debug = html`<pre>${JSON.stringify(info, true, 2)}</pre>`
    let bytype
    if (info.type === 'hyperdrive') bytype = hyperdrive(key, data, writable)
    if (info.type === 'hypercore') bytype = hypercore(key, data, writable)
    return html`
      <div class="core-view">
        <h2><em>${info.type}</em><br />${key}</h2>
        ${bytype}
        <hr />
        ${debug}
      </div>`
  }

  // utility for categorizing file types and guessing filetype using
  // https://github.com/pfraze/identify-filetype#readme
  function fileutils() {
    const exts = {
      img: ['jpg', 'png', 'gif', 'bmp', 'tif', 'tiff', 'svg'],
      bin: ['rar', 'zip', 'gz', 'msi', 'iso', 'rtf', 'avi', 'wmv', 'wma', 'swf', 'flv', 'mid', 'pdf', 'doc', 'docx', 'mp3', 'nif', 'ico', 'psd'],
      txt: ['md', 'js', 'json', 'txt'] // TODO use this array
    }
    return {
      guess: function (path, src, encoding = false) {
        console.log(`\n\nguessing for ${path}...`)
        let mimeGuessFromPath = mime.getType(path)
        let mimeParts = _.split(_.toLower(mimeGuessFromPath), '/')
        let isSrc = _.endsWith(mimeParts[1], 'json') || _.endsWith(mimeParts[1], 'javascript')
        console.log('mimeGuessFromPath :', mimeGuessFromPath)

        let validEncodings = new Set(['buf', 'b64', 'str'])
        if (!validEncodings.has(encoding)) {
          
          switch (mimeParts[0]) {
            case 'image':
              encoding = 'b64'
              break;
            case 'text':
              encoding = 'str'
              break;
            case 'application':
              encoding = isSrc ? 'str' : 'bin'
              break;
            default:
              console.warn(`warn: not sure what encoding for ${path} (${mimeGuessFromPath}), defaulting to utf8 string`)
              encoding = 'str';
          }            
        }
        console.log(encoding)
        let encoders = {
          buf: src => src,
          bin: src => codecs().encode(src), // TODO guess don't need both bin and b64...
          b64: src => codecs().encode(src),
          str: src => codecs('utf8').encode(src.toString()) // treat as string or binary
        }
        let buf = encoders[encoding](src)
        //TODO using mime package this way is circular? is it any better than just grabbing the .ext?
        let guessedType = identify(buf) || mime.getExtension(mimeGuessFromPath);
        let imgext = _.find(exts.img, ext => ext === guessedType)
        let binext = _.find(exts.bin, ext => ext === guessedType)
        let isImage = imgext ? true : false
        let isBinary = binext ? true : false
        // let isSrc = see above
        let ext = false || imgext || binext || guessedType
        let mimetype = mime.getType(ext)
        let meta = {buf, guessedType, imgext, binext, isImage, isBinary, ext, mimetype} 
        console.log(meta, "\n#####################")
        return {isImage, isBinary, isSrc, ext, mimetype}
      },
      // TODO decide if useful for efficiency vs guess - probably not
      // isImg: function (path) {
      //   let imgext = false
      //   if (_.some(exts.img, ext => {
      //     if (path.endsWith('.' + ext)) {
      //       imgext = ext
      //       return true;
      //     }
      //   }))
      //   return imgext
      //     ? {isImage: true, ext: imgext, mimetype: `image/${imgext}`}
      //     : {isImage: false, ext: 'false', mimetype: `text`}
      // }
    };
  }

  function hyperdrive (key, data, writable) {
    return html`
      <div class="listing" style="width:50vw;">
        ${data ? html`
          <ul>
            ${Object.entries( data ).map( ( [ path, d ], idx ) => {
              
              // if ( _.some(extensions.img, ext => path.endsWith('.' + ext)) ){
              // let ft = fileutils().isImg(path)
              let ft = fileutils().guess(path, d)
              console.log("\n#########################\n", ft, "\n#########################\n")
              if (ft.isImage) {
                let dataurl = `data:${ft.mimetype};base64,` + codecs('base64').decode(codecs().encode(d))
                console.log(`file#${idx} (${ft.ext}): ` + dataurl.slice(0, 400))
                return html`<li><strong>/${path}:</strong> <p><img src=${dataurl}/></p></li>` 
              
              } else if (ft.isSrc) {
                let srcCode = JSON.stringify(JSON.parse(d.toString()), null, 2) // TODO add other languages, syntax highlighting
                return html`<li><strong>/${path}:</strong><p><code class="srcCode">${srcCode}</code></p></li>`
              
              } else {
                let lines = _.split(d.toString(), '\n')
                let paras = lines.map(line => `<p>${line}</p>`).join('\n')
                paras = html`${paras}`
                console.log(paras)
                return html`<li><strong>/${path}:</strong><section>${raw(paras)}</section></li>`
              }
            })}
          </ul>
        ` : ''}
        ${writable ? html`
          <form onsubmit=${onsubmit}>
            <label>Path</label><br />
            <input type="text" name="path" /><br />
            <label>Content</label><br />
            <textarea name="data"></textarea><br />
            <button type="submit">Write!</button>
          </form>
        ` : ''}
      </div>
    `
    function onsubmit (e) {
      const { path, data } = formData(e)
      emit('hyperdrive:writeFile', { key, path, data })
    }
  }

  function hypercore (key, data, writable) {
    return html`
      <div>
        <ul>
          ${data.map((d, i) => html`<li><strong>${i}:</strong> ${d}</li>`)}
        </ul>
        ${writable ? html`
          <form onsubmit=${onsubmit}>
            <textarea name="data"></textarea><br />
            <button type="submit">Append!</button>
          </form>
        ` : ''}
      </div>
    `
    function onsubmit (e) {
      const { data } = formData(e)
      emit('hypercore:append', { key, data })
    }
  }
}

function hex (key) {
  return Buffer.isBuffer(key) ? key.toString('hex') : key
}

function formData (e) {
  e.preventDefault()
  const object = {}
  const data = new window.FormData(e.currentTarget)
  data.forEach((value, key) => { object[key] = value })
  return object
}

let small16x16gif = 'data:image/gif;base64,R0lGODlhDwAPAKECAAAAzMzM/////wAAACwAAAAADwAPAAACIISPeQHsrZ5ModrLlN48CXF8m2iQ3YmmKqVlRtW4MLwWACH+H09wdGltaXplZCBieSBVbGVhZCBTbWFydFNhdmVyIQAAOw=='

let fillMurray32x32_B64 = `data:image/png;base64,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
`