const Corestore = require('./browser')
var raw = require('nanohtml/raw')
var html = require('nanohtml')
var choo = require('choo')
const hyperdrive = require('hyperdrive')
const hypercore = require('hypercore')
const factories = { hyperdrive, hypercore }
const _ = require( 'lodash' );
const codecs = require('codecs')
const identify = require('identify-filetype')
const mime = require('mime/lite');

var remark = require('remark')
var recommended = require('remark-preset-lint-recommended')
var rehtml = require('remark-html')
var report = require('vfile-reporter')

function remarkPromise(mdstr) {
  console.log("returning remarkPromise")
  return new Promise((res) => {
    remark()
    .use(recommended)
    .use(rehtml)
    .process(mdstr, function(err, file) {
      // console.warn(report(err || file)) //dontcare
      console.log(String(file).slice(0,100))
      res('hi from tidy' + String(file))
      // return String(file)
    })
  })
}

async function tidymark(mdstr) {
  let tidyied0 = remarkPromise(mdstr)
    .then(str => {console.warn; return str})
  // let tidyied = await remarkPromise(mdstr).then(str => str)
  console.log('tidymark: got tidyied md...')
  return tidyied0;
}

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
        // console.log(`\n\nguessing for ${path}...`)
        let mimeGuessFromPath = mime.getType(path)
        let mimeParts = _.split(_.toLower(mimeGuessFromPath), '/')
        let isSrc = _.endsWith(mimeParts[1], 'json') || _.endsWith(mimeParts[1], 'javascript')
        // console.log('mimeGuessFromPath :', mimeGuessFromPath)

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
        // console.log(encoding)
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
        // console.log(meta, "\n#####################")
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
              
              let ft = fileutils().guess(path, d)
              // console.log("\n#########################\n", ft, "\n#########################\n")

              if (ft.isImage) {
                let dataurl = `data:${ft.mimetype};base64,` + codecs('base64').decode(codecs().encode(d))
                // console.log(`file#${idx} (${ft.ext}): ` + dataurl.slice(0, 400))
                return html`<li><strong>/${path}:</strong> <p><img src=${dataurl}/></p></li>`
              
              } else if (ft.isSrc) {
                let srcCode = JSON.stringify(JSON.parse(d.toString(), null, 2)) // TODO add other languages, syntax highlighting
                return html`<li><strong>/${path}:</strong><p><code class="srcCode">${srcCode}</code></p></li>`
              
              } else if (ft.ext === 'markdown') {
                // tidymark(d.toString()).then(tidytstr => {
                // console.log(tidystr)
                // })
                // let tidier = tidymark(d.toString()).then(str => {
                //   console.log('about to inject tidymark html into choo', str)  
                //   return html`<li><strong>/${path}:</strong><p><code class="markdown">${str}</code></p></li>`
                // })

                let processed = remark()
                  .use(recommended)
                  .use(rehtml)
                  .processSync(d.toString(), function (err, file) {
                    // console.warn(report(err || file)) //dontcare
                    console.log(String(file).slice(0, 100))
                  }).toString()
                
                return html`<li><strong>/${path}:</strong><p><code class="markdown">${raw(processed)}</code></p></li>`

                // return html`<li><strong>/${path}:</strong><p><code class="markdown">${d.toString()}</code></p></li>`
              

              } else {
                let lines = _.split(d.toString(), '\n')
                let paras = lines.map(line => `<p>${line}</p>`).join('\n')
                paras = html`${paras}`
                console.log(paras.slice(0,100))
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