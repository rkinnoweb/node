// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

const EventEmitter = require('events');
const stream = require('stream');
const timers = require('timers');
const util = require('util');
const internalUtil = require('internal/util');
const internalNet = require('internal/net');
const assert = require('assert');
const cares = process.binding('cares_wrap');
const uv = process.binding('uv');

const Buffer = require('buffer').Buffer;
const TTYWrap = process.binding('tty_wrap');
const TCP = process.binding('tcp_wrap').TCP;
const Pipe = process.binding('pipe_wrap').Pipe;
const TCPConnectWrap = process.binding('tcp_wrap').TCPConnectWrap;
const PipeConnectWrap = process.binding('pipe_wrap').PipeConnectWrap;
const ShutdownWrap = process.binding('stream_wrap').ShutdownWrap;
const WriteWrap = process.binding('stream_wrap').WriteWrap;


var cluster;
const errnoException = util._errnoException;
const exceptionWithHostPort = util._exceptionWithHostPort;
const isLegalPort = internalNet.isLegalPort;

function noop() {}

function createHandle(fd) {
  var type = TTYWrap.guessHandleType(fd);
  if (type === 'PIPE') return new Pipe();
  if (type === 'TCP') return new TCP();
  throw new TypeError('Unsupported fd type: ' + type);
}


const debug = util.debuglog('net');

function isPipeName(s) {
  return typeof s === 'string' && toNumber(s) === false;
}

function createServer(options, connectionListener) {
  return new Server(options, connectionListener);
}


// Target API:
//
// var s = net.connect({port: 80, host: 'google.com'}, function() {
//   ...
// });
//
// There are various forms:
//
// connect(options, [cb])
// connect(port, [host], [cb])
// connect(path, [cb]);
//
function connect() {
  const args = new Array(arguments.length);
  for (var i = 0; i < arguments.length; i++)
    args[i] = arguments[i];
  // TODO(joyeecheung): use destructuring when V8 is fast enough
  const normalized = normalizeArgs(args);
  const options = normalized[0];
  const cb = normalized[1];
  debug('createConnection', normalized);
  const socket = new Socket(options);

  if (options.timeout) {
    socket.setTimeout(options.timeout);
  }

  return Socket.prototype.connect.call(socket, options, cb);
}


// Returns an array [options, cb], where options is an object,
// cb is either a funciton or null.
// Used to normalize arguments of Socket.prototype.connect() and
// Server.prototype.listen(). Possible combinations of paramters:
//   (options[...][, cb])
//   (path[...][, cb])
//   ([port][, host][...][, cb])
// For Socket.prototype.connect(), the [...] part is ignored
// For Server.prototype.listen(), the [...] part is [, backlog]
// but will not be handled here (handled in listen())
function normalizeArgs(args) {
  if (args.length === 0) {
    return [{}, null];
  }

  const arg0 = args[0];
  var options = {};
  if (typeof arg0 === 'object' && arg0 !== null) {
    // (options[...][, cb])
    options = arg0;
  } else if (isPipeName(arg0)) {
    // (path[...][, cb])
    options.path = arg0;
  } else {
    // ([port][, host][...][, cb])
    options.port = arg0;
    if (args.length > 1 && typeof args[1] === 'string') {
      options.host = args[1];
    }
  }

  var cb = args[args.length - 1];
  if (typeof cb !== 'function')
    return [options, null];
  else
    return [options, cb];
}


// called when creating new Socket, or when re-using a closed Socket
function initSocketHandle(self) {
  self.destroyed = false;
  self._bytesDispatched = 0;
  self._sockname = null;

  // Handle creation may be deferred to bind() or connect() time.
  if (self._handle) {
    self._handle.owner = self;
    self._handle.onread = onread;

    // If handle doesn't support writev - neither do we
    if (!self._handle.writev)
      self._writev = null;
  }
}


const BYTES_READ = Symbol('bytesRead');


function Socket(options) {
  if (!(this instanceof Socket)) return new Socket(options);

  this.connecting = false;
  this._hadError = false;
  this._handle = null;
  this._parent = null;
  this._host = null;

  if (typeof options === 'number')
    options = { fd: options }; // Legacy interface.
  else if (options === undefined)
    options = {};

  stream.Duplex.call(this, options);

  if (options.handle) {
    this._handle = options.handle; // private
  } else if (options.fd !== undefined) {
    this._handle = createHandle(options.fd);
    this._handle.open(options.fd);
    // options.fd can be string (since it user-defined),
    // so changing this to === would be semver-major
    // See: https://github.com/nodejs/node/pull/11513
    if ((options.fd == 1 || options.fd == 2) &&
        (this._handle instanceof Pipe) &&
        process.platform === 'win32') {
      // Make stdout and stderr blocking on Windows
      var err = this._handle.setBlocking(true);
      if (err)
        throw errnoException(err, 'setBlocking');
    }
    this.readable = options.readable !== false;
    this.writable = options.writable !== false;
  } else {
    // these will be set once there is a connection
    this.readable = this.writable = false;
  }

  // shut down the socket when we're finished with it.
  this.on('finish', onSocketFinish);
  this.on('_socketEnd', onSocketEnd);

  initSocketHandle(this);

  this._pendingData = null;
  this._pendingEncoding = '';

  // handle strings directly
  this._writableState.decodeStrings = false;

  // default to *not* allowing half open sockets
  this.allowHalfOpen = options && options.allowHalfOpen || false;

  // if we have a handle, then start the flow of data into the
  // buffer.  if not, then this will happen when we connect
  if (this._handle && options.readable !== false) {
    if (options.pauseOnCreate) {
      // stop the handle from reading and pause the stream
      this._handle.reading = false;
      this._handle.readStop();
      this._readableState.flowing = false;
    } else {
      this.read(0);
    }
  }

  // Reserve properties
  this.server = null;
  this._server = null;

  // Used after `.destroy()`
  this[BYTES_READ] = 0;
}
util.inherits(Socket, stream.Duplex);

Socket.prototype._unrefTimer = function _unrefTimer() {
  for (var s = this; s !== null; s = s._parent)
    timers._unrefActive(s);
};

// the user has called .end(), and all the bytes have been
// sent out to the other side.
function onSocketFinish() {
  // If still connecting - defer handling 'finish' until 'connect' will happen
  if (this.connecting) {
    debug('osF: not yet connected');
    return this.once('connect', onSocketFinish);
  }

  debug('onSocketFinish');
  if (!this.readable || this._readableState.ended) {
    debug('oSF: ended, destroy', this._readableState);
    return this.destroy();
  }

  debug('oSF: not ended, call shutdown()');

  // otherwise, just shutdown, or destroy() if not possible
  if (!this._handle || !this._handle.shutdown)
    return this.destroy();

  var req = new ShutdownWrap();
  req.oncomplete = afterShutdown;
  req.handle = this._handle;
  var err = this._handle.shutdown(req);

  if (err)
    return this._destroy(errnoException(err, 'shutdown'));
}


function afterShutdown(status, handle, req) {
  var self = handle.owner;

  debug('afterShutdown destroyed=%j', self.destroyed,
        self._readableState);

  // callback may come after call to destroy.
  if (self.destroyed)
    return;

  if (self._readableState.ended) {
    debug('readableState ended, destroying');
    self.destroy();
  } else {
    self.once('_socketEnd', self.destroy);
  }
}

// the EOF has been received, and no more bytes are coming.
// if the writable side has ended already, then clean everything
// up.
function onSocketEnd() {
  // XXX Should not have to do as much crap in this function.
  // ended should already be true, since this is called *after*
  // the EOF errno and onread has eof'ed
  debug('onSocketEnd', this._readableState);
  this._readableState.ended = true;
  if (this._readableState.endEmitted) {
    this.readable = false;
    maybeDestroy(this);
  } else {
    this.once('end', function end() {
      this.readable = false;
      maybeDestroy(this);
    });
    this.read(0);
  }

  if (!this.allowHalfOpen) {
    this.write = writeAfterFIN;
    this.destroySoon();
  }
}

// Provide a better error message when we call end() as a result
// of the other side sending a FIN.  The standard 'write after end'
// is overly vague, and makes it seem like the user's code is to blame.
function writeAfterFIN(chunk, encoding, cb) {
  if (typeof encoding === 'function') {
    cb = encoding;
    encoding = null;
  }

  var er = new Error('This socket has been ended by the other party');
  er.code = 'EPIPE';
  // TODO: defer error events consistently everywhere, not just the cb
  this.emit('error', er);
  if (typeof cb === 'function') {
    process.nextTick(cb, er);
  }
}

Socket.prototype.read = function(n) {
  if (n === 0)
    return stream.Readable.prototype.read.call(this, n);

  this.read = stream.Readable.prototype.read;
  this._consuming = true;
  return this.read(n);
};


Socket.prototype.listen = function() {
  debug('socket.listen');
  this.on('connection', arguments[0]);
  listen(this, null, null, null);
};


Socket.prototype.setTimeout = function(msecs, callback) {
  if (msecs === 0) {
    timers.unenroll(this);
    if (callback) {
      this.removeListener('timeout', callback);
    }
  } else {
    timers.enroll(this, msecs);
    timers._unrefActive(this);
    if (callback) {
      this.once('timeout', callback);
    }
  }
  return this;
};


Socket.prototype._onTimeout = function() {
  debug('_onTimeout');
  this.emit('timeout');
};


Socket.prototype.setNoDelay = function(enable) {
  if (!this._handle) {
    this.once('connect',
              enable ? this.setNoDelay : () => this.setNoDelay(enable));
    return this;
  }

  // backwards compatibility: assume true when `enable` is omitted
  if (this._handle.setNoDelay)
    this._handle.setNoDelay(enable === undefined ? true : !!enable);

  return this;
};


Socket.prototype.setKeepAlive = function(setting, msecs) {
  if (!this._handle) {
    this.once('connect', () => this.setKeepAlive(setting, msecs));
    return this;
  }

  if (this._handle.setKeepAlive)
    this._handle.setKeepAlive(setting, ~~(msecs / 1000));

  return this;
};


Socket.prototype.address = function() {
  return this._getsockname();
};


Object.defineProperty(Socket.prototype, '_connecting', {
  get: function() {
    return this.connecting;
  }
});


Object.defineProperty(Socket.prototype, 'readyState', {
  get: function() {
    if (this.connecting) {
      return 'opening';
    } else if (this.readable && this.writable) {
      return 'open';
    } else if (this.readable && !this.writable) {
      return 'readOnly';
    } else if (!this.readable && this.writable) {
      return 'writeOnly';
    } else {
      return 'closed';
    }
  }
});


Object.defineProperty(Socket.prototype, 'bufferSize', {
  get: function() {
    if (this._handle) {
      return this._handle.writeQueueSize + this._writableState.length;
    }
  }
});


// Just call handle.readStart until we have enough in the buffer
Socket.prototype._read = function(n) {
  debug('_read');

  if (this.connecting || !this._handle) {
    debug('_read wait for connection');
    this.once('connect', () => this._read(n));
  } else if (!this._handle.reading) {
    // not already reading, start the flow
    debug('Socket._read readStart');
    this._handle.reading = true;
    var err = this._handle.readStart();
    if (err)
      this._destroy(errnoException(err, 'read'));
  }
};


Socket.prototype.end = function(data, encoding) {
  stream.Duplex.prototype.end.call(this, data, encoding);
  this.writable = false;
  DTRACE_NET_STREAM_END(this);
  LTTNG_NET_STREAM_END(this);

  // just in case we're waiting for an EOF.
  if (this.readable && !this._readableState.endEmitted)
    this.read(0);
  else
    maybeDestroy(this);
};


// Call whenever we set writable=false or readable=false
function maybeDestroy(socket) {
  if (!socket.readable &&
      !socket.writable &&
      !socket.destroyed &&
      !socket.connecting &&
      !socket._writableState.length) {
    socket.destroy();
  }
}


Socket.prototype.destroySoon = function() {
  if (this.writable)
    this.end();

  if (this._writableState.finished)
    this.destroy();
  else
    this.once('finish', this.destroy);
};


Socket.prototype._destroy = function(exception, cb) {
  debug('destroy');

  function fireErrorCallbacks(self) {
    if (cb) cb(exception);
    if (exception && !self._writableState.errorEmitted) {
      process.nextTick(emitErrorNT, self, exception);
      self._writableState.errorEmitted = true;
    }
  }

  if (this.destroyed) {
    debug('already destroyed, fire error callbacks');
    fireErrorCallbacks(this);
    return;
  }

  this.connecting = false;

  this.readable = this.writable = false;

  for (var s = this; s !== null; s = s._parent)
    timers.unenroll(s);

  debug('close');
  if (this._handle) {
    if (this !== process.stderr)
      debug('close handle');
    var isException = exception ? true : false;
    // `bytesRead` should be accessible after `.destroy()`
    this[BYTES_READ] = this._handle.bytesRead;

    this._handle.close(() => {
      debug('emit close');
      this.emit('close', isException);
    });
    this._handle.onread = noop;
    this._handle = null;
    this._sockname = null;
  }

  // we set destroyed to true before firing error callbacks in order
  // to make it re-entrance safe in case Socket.prototype.destroy()
  // is called within callbacks
  this.destroyed = true;
  fireErrorCallbacks(this);

  if (this._server) {
    COUNTER_NET_SERVER_CONNECTION_CLOSE(this);
    debug('has server');
    this._server._connections--;
    if (this._server._emitCloseIfDrained) {
      this._server._emitCloseIfDrained();
    }
  }
};


Socket.prototype.destroy = function(exception) {
  debug('destroy', exception);
  this._destroy(exception);
};


// This function is called whenever the handle gets a
// buffer, or when there's an error reading.
function onread(nread, buffer) {
  var handle = this;
  var self = handle.owner;
  assert(handle === self._handle, 'handle != self._handle');

  self._unrefTimer();

  debug('onread', nread);

  if (nread > 0) {
    debug('got data');

    // read success.
    // In theory (and in practice) calling readStop right now
    // will prevent this from being called again until _read() gets
    // called again.

    // Optimization: emit the original buffer with end points
    var ret = self.push(buffer);

    if (handle.reading && !ret) {
      handle.reading = false;
      debug('readStop');
      var err = handle.readStop();
      if (err)
        self._destroy(errnoException(err, 'read'));
    }
    return;
  }

  // if we didn't get any bytes, that doesn't necessarily mean EOF.
  // wait for the next one.
  if (nread === 0) {
    debug('not any data, keep waiting');
    return;
  }

  // Error, possibly EOF.
  if (nread !== uv.UV_EOF) {
    return self._destroy(errnoException(nread, 'read'));
  }

  debug('EOF');

  // push a null to signal the end of data.
  // Do it before `maybeDestroy` for correct order of events:
  // `end` -> `close`
  self.push(null);

  if (self._readableState.length === 0) {
    self.readable = false;
    maybeDestroy(self);
  }

  // internal end event so that we know that the actual socket
  // is no longer readable, and we can start the shutdown
  // procedure. No need to wait for all the data to be consumed.
  self.emit('_socketEnd');
}


Socket.prototype._getpeername = function() {
  if (!this._peername) {
    if (!this._handle || !this._handle.getpeername) {
      return {};
    }
    var out = {};
    var err = this._handle.getpeername(out);
    if (err) return {};  // FIXME(bnoordhuis) Throw?
    this._peername = out;
  }
  return this._peername;
};

function protoGetter(name, callback) {
  Object.defineProperty(Socket.prototype, name, {
    configurable: false,
    enumerable: true,
    get: callback
  });
}

protoGetter('bytesRead', function bytesRead() {
  return this._handle ? this._handle.bytesRead : this[BYTES_READ];
});

protoGetter('remoteAddress', function remoteAddress() {
  return this._getpeername().address;
});

protoGetter('remoteFamily', function remoteFamily() {
  return this._getpeername().family;
});

protoGetter('remotePort', function remotePort() {
  return this._getpeername().port;
});


Socket.prototype._getsockname = function() {
  if (!this._handle || !this._handle.getsockname) {
    return {};
  }
  if (!this._sockname) {
    var out = {};
    var err = this._handle.getsockname(out);
    if (err) return {};  // FIXME(bnoordhuis) Throw?
    this._sockname = out;
  }
  return this._sockname;
};


protoGetter('localAddress', function localAddress() {
  return this._getsockname().address;
});


protoGetter('localPort', function localPort() {
  return this._getsockname().port;
});


Socket.prototype.write = function(chunk, encoding, cb) {
  if (typeof chunk !== 'string' && !(chunk instanceof Buffer)) {
    throw new TypeError(
      'Invalid data, chunk must be a string or buffer, not ' + typeof chunk);
  }
  return stream.Duplex.prototype.write.apply(this, arguments);
};


Socket.prototype._writeGeneric = function(writev, data, encoding, cb) {
  // If we are still connecting, then buffer this for later.
  // The Writable logic will buffer up any more writes while
  // waiting for this one to be done.
  if (this.connecting) {
    this._pendingData = data;
    this._pendingEncoding = encoding;
    this.once('connect', function connect() {
      this._writeGeneric(writev, data, encoding, cb);
    });
    return;
  }
  this._pendingData = null;
  this._pendingEncoding = '';

  this._unrefTimer();

  if (!this._handle) {
    this._destroy(new Error('This socket is closed'), cb);
    return false;
  }

  var req = new WriteWrap();
  req.handle = this._handle;
  req.oncomplete = afterWrite;
  req.async = false;
  var err;

  if (writev) {
    var chunks = new Array(data.length << 1);
    for (var i = 0; i < data.length; i++) {
      var entry = data[i];
      chunks[i * 2] = entry.chunk;
      chunks[i * 2 + 1] = entry.encoding;
    }
    err = this._handle.writev(req, chunks);

    // Retain chunks
    if (err === 0) req._chunks = chunks;
  } else {
    var enc;
    if (data instanceof Buffer) {
      enc = 'buffer';
    } else {
      enc = encoding;
    }
    err = createWriteReq(req, this._handle, data, enc);
  }

  if (err)
    return this._destroy(errnoException(err, 'write', req.error), cb);

  this._bytesDispatched += req.bytes;

  // If it was entirely flushed, we can write some more right now.
  // However, if more is left in the queue, then wait until that clears.
  if (req.async && this._handle.writeQueueSize != 0)
    req.cb = cb;
  else
    cb();
};


Socket.prototype._writev = function(chunks, cb) {
  this._writeGeneric(true, chunks, '', cb);
};


Socket.prototype._write = function(data, encoding, cb) {
  this._writeGeneric(false, data, encoding, cb);
};

function createWriteReq(req, handle, data, encoding) {
  switch (encoding) {
    case 'latin1':
    case 'binary':
      return handle.writeLatin1String(req, data);

    case 'buffer':
      return handle.writeBuffer(req, data);

    case 'utf8':
    case 'utf-8':
      return handle.writeUtf8String(req, data);

    case 'ascii':
      return handle.writeAsciiString(req, data);

    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      return handle.writeUcs2String(req, data);

    default:
      return handle.writeBuffer(req, Buffer.from(data, encoding));
  }
}


protoGetter('bytesWritten', function bytesWritten() {
  var bytes = this._bytesDispatched;
  const state = this._writableState;
  const data = this._pendingData;
  const encoding = this._pendingEncoding;

  if (!state)
    return undefined;

  state.getBuffer().forEach(function(el) {
    if (el.chunk instanceof Buffer)
      bytes += el.chunk.length;
    else
      bytes += Buffer.byteLength(el.chunk, el.encoding);
  });

  if (data) {
    if (data instanceof Buffer)
      bytes += data.length;
    else
      bytes += Buffer.byteLength(data, encoding);
  }

  return bytes;
});


function afterWrite(status, handle, req, err) {
  var self = handle.owner;
  if (self !== process.stderr && self !== process.stdout)
    debug('afterWrite', status);

  // callback may come after call to destroy.
  if (self.destroyed) {
    debug('afterWrite destroyed');
    return;
  }

  if (status < 0) {
    var ex = errnoException(status, 'write', req.error);
    debug('write failure', ex);
    self._destroy(ex, req.cb);
    return;
  }

  self._unrefTimer();

  if (self !== process.stderr && self !== process.stdout)
    debug('afterWrite call cb');

  if (req.cb)
    req.cb.call(self);
}


function internalConnect(
  self, address, port, addressType, localAddress, localPort) {
  // TODO return promise from Socket.prototype.connect which
  // wraps _connectReq.

  assert.ok(self.connecting);

  var err;

  if (localAddress || localPort) {
    var bind;

    if (addressType === 4) {
      localAddress = localAddress || '0.0.0.0';
      bind = self._handle.bind;
    } else if (addressType === 6) {
      localAddress = localAddress || '::';
      bind = self._handle.bind6;
    } else {
      self._destroy(new TypeError('Invalid addressType: ' + addressType));
      return;
    }

    debug('binding to localAddress: %s and localPort: %d',
          localAddress,
          localPort);

    bind = bind.bind(self._handle);
    err = bind(localAddress, localPort);

    if (err) {
      const ex = exceptionWithHostPort(err, 'bind', localAddress, localPort);
      self._destroy(ex);
      return;
    }
  }

  if (addressType === 6 || addressType === 4) {
    const req = new TCPConnectWrap();
    req.oncomplete = afterConnect;
    req.address = address;
    req.port = port;
    req.localAddress = localAddress;
    req.localPort = localPort;

    if (addressType === 4)
      err = self._handle.connect(req, address, port);
    else
      err = self._handle.connect6(req, address, port);

  } else {
    const req = new PipeConnectWrap();
    req.address = address;
    req.oncomplete = afterConnect;
    err = self._handle.connect(req, address, afterConnect);
  }

  if (err) {
    var sockname = self._getsockname();
    var details;

    if (sockname) {
      details = sockname.address + ':' + sockname.port;
    }

    const ex = exceptionWithHostPort(err, 'connect', address, port, details);
    self._destroy(ex);
  }
}


Socket.prototype.connect = function() {
  const args = new Array(arguments.length);
  for (var i = 0; i < arguments.length; i++)
    args[i] = arguments[i];
  // TODO(joyeecheung): use destructuring when V8 is fast enough
  const normalized = normalizeArgs(args);
  const options = normalized[0];
  const cb = normalized[1];

  if (this.write !== Socket.prototype.write)
    this.write = Socket.prototype.write;

  if (this.destroyed) {
    this._readableState.reading = false;
    this._readableState.ended = false;
    this._readableState.endEmitted = false;
    this._writableState.ended = false;
    this._writableState.ending = false;
    this._writableState.finished = false;
    this._writableState.errorEmitted = false;
    this.destroyed = false;
    this._handle = null;
    this._peername = null;
    this._sockname = null;
  }

  var pipe = !!options.path;
  debug('pipe', pipe, options.path);

  if (!this._handle) {
    this._handle = pipe ? new Pipe() : new TCP();
    initSocketHandle(this);
  }

  if (cb !== null) {
    this.once('connect', cb);
  }

  this._unrefTimer();

  this.connecting = true;
  this.writable = true;

  if (pipe) {
    internalConnect(this, options.path);
  } else {
    lookupAndConnect(this, options);
  }
  return this;
};


function lookupAndConnect(self, options) {
  const dns = require('dns');
  var host = options.host || 'localhost';
  var port = options.port;
  var localAddress = options.localAddress;
  var localPort = options.localPort;

  if (localAddress && !cares.isIP(localAddress))
    throw new TypeError('"localAddress" option must be a valid IP: ' +
                        localAddress);

  if (localPort && typeof localPort !== 'number')
    throw new TypeError('"localPort" option should be a number: ' + localPort);

  if (typeof port !== 'undefined') {
    if (typeof port !== 'number' && typeof port !== 'string')
      throw new TypeError('"port" option should be a number or string: ' +
                          port);
    if (!isLegalPort(port))
      throw new RangeError('"port" option should be >= 0 and < 65536: ' + port);
  }
  port |= 0;

  // If host is an IP, skip performing a lookup
  var addressType = cares.isIP(host);
  if (addressType) {
    process.nextTick(function() {
      if (self.connecting)
        internalConnect(self, host, port, addressType, localAddress, localPort);
    });
    return;
  }

  if (options.lookup && typeof options.lookup !== 'function')
    throw new TypeError('"lookup" option should be a function');

  var dnsopts = {
    family: options.family,
    hints: options.hints || 0
  };

  if (dnsopts.family !== 4 && dnsopts.family !== 6 && dnsopts.hints === 0) {
    dnsopts.hints = dns.ADDRCONFIG;
  }

  debug('connect: find host ' + host);
  debug('connect: dns options', dnsopts);
  self._host = host;
  var lookup = options.lookup || dns.lookup;
  lookup(host, dnsopts, function emitLookup(err, ip, addressType) {
    self.emit('lookup', err, ip, addressType, host);

    // It's possible we were destroyed while looking this up.
    // XXX it would be great if we could cancel the promise returned by
    // the look up.
    if (!self.connecting) return;

    if (err) {
      // net.createConnection() creates a net.Socket object and
      // immediately calls net.Socket.connect() on it (that's us).
      // There are no event listeners registered yet so defer the
      // error event to the next tick.
      err.host = options.host;
      err.port = options.port;
      err.message = err.message + ' ' + options.host + ':' + options.port;
      process.nextTick(connectErrorNT, self, err);
    } else {
      self._unrefTimer();
      internalConnect(self,
                      ip,
                      port,
                      addressType,
                      localAddress,
                      localPort);
    }
  });
}


function connectErrorNT(self, err) {
  self.emit('error', err);
  self._destroy();
}


Socket.prototype.ref = function() {
  if (!this._handle) {
    this.once('connect', this.ref);
    return this;
  }

  this._handle.ref();

  return this;
};


Socket.prototype.unref = function() {
  if (!this._handle) {
    this.once('connect', this.unref);
    return this;
  }

  this._handle.unref();

  return this;
};


function afterConnect(status, handle, req, readable, writable) {
  var self = handle.owner;

  // callback may come after call to destroy
  if (self.destroyed) {
    return;
  }

  // Update handle if it was wrapped
  // TODO(indutny): assert that the handle is actually an ancestor of old one
  handle = self._handle;

  debug('afterConnect');

  assert.ok(self.connecting);
  self.connecting = false;
  self._sockname = null;

  if (status === 0) {
    self.readable = readable;
    self.writable = writable;
    self._unrefTimer();

    self.emit('connect');

    // start the first read, or get an immediate EOF.
    // this doesn't actually consume any bytes, because len=0.
    if (readable && !self.isPaused())
      self.read(0);

  } else {
    self.connecting = false;
    var details;
    if (req.localAddress && req.localPort) {
      details = req.localAddress + ':' + req.localPort;
    }
    var ex = exceptionWithHostPort(status,
                                   'connect',
                                   req.address,
                                   req.port,
                                   details);
    if (details) {
      ex.localAddress = req.localAddress;
      ex.localPort = req.localPort;
    }
    self._destroy(ex);
  }
}


function Server(options, connectionListener) {
  if (!(this instanceof Server))
    return new Server(options, connectionListener);

  EventEmitter.call(this);

  if (typeof options === 'function') {
    connectionListener = options;
    options = {};
    this.on('connection', connectionListener);
  } else if (options == null || typeof options === 'object') {
    options = options || {};

    if (typeof connectionListener === 'function') {
      this.on('connection', connectionListener);
    }
  } else {
    throw new TypeError('options must be an object');
  }

  this._connections = 0;

  Object.defineProperty(this, 'connections', {
    get: internalUtil.deprecate(() => {

      if (this._usingSlaves) {
        return null;
      }
      return this._connections;
    }, 'Server.connections property is deprecated. ' +
       'Use Server.getConnections method instead.', 'DEP0020'),
    set: internalUtil.deprecate((val) => (this._connections = val),
                                'Server.connections property is deprecated.',
                                'DEP0020'),
    configurable: true, enumerable: false
  });

  this._handle = null;
  this._usingSlaves = false;
  this._slaves = [];
  this._unref = false;

  this.allowHalfOpen = options.allowHalfOpen || false;
  this.pauseOnConnect = !!options.pauseOnConnect;
}
util.inherits(Server, EventEmitter);


function toNumber(x) { return (x = Number(x)) >= 0 ? x : false; }

function _listen(handle, backlog) {
  // Use a backlog of 512 entries. We pass 511 to the listen() call because
  // the kernel does: backlogsize = roundup_pow_of_two(backlogsize + 1);
  // which will thus give us a backlog of 512 entries.
  return handle.listen(backlog || 511);
}

function createServerHandle(address, port, addressType, fd) {
  var err = 0;
  // assign handle in listen, and clean up if bind or listen fails
  var handle;

  var isTCP = false;
  if (typeof fd === 'number' && fd >= 0) {
    try {
      handle = createHandle(fd);
    } catch (e) {
      // Not a fd we can listen on.  This will trigger an error.
      debug('listen invalid fd=' + fd + ': ' + e.message);
      return uv.UV_EINVAL;
    }
    handle.open(fd);
    handle.readable = true;
    handle.writable = true;
    assert(!address && !port);
  } else if (port === -1 && addressType === -1) {
    handle = new Pipe();
    if (process.platform === 'win32') {
      var instances = parseInt(process.env.NODE_PENDING_PIPE_INSTANCES);
      if (!isNaN(instances)) {
        handle.setPendingInstances(instances);
      }
    }
  } else {
    handle = new TCP();
    isTCP = true;
  }

  if (address || port || isTCP) {
    debug('bind to ' + (address || 'anycast'));
    if (!address) {
      // Try binding to ipv6 first
      err = handle.bind6('::', port);
      if (err) {
        handle.close();
        // Fallback to ipv4
        return createServerHandle('0.0.0.0', port);
      }
    } else if (addressType === 6) {
      err = handle.bind6(address, port);
    } else {
      err = handle.bind(address, port);
    }
  }

  if (err) {
    handle.close();
    return err;
  }

  return handle;
}


Server.prototype._listen2 = function(address, port, addressType, backlog, fd) {
  debug('listen2', address, port, addressType, backlog, fd);

  // If there is not yet a handle, we need to create one and bind.
  // In the case of a server sent via IPC, we don't need to do this.
  if (this._handle) {
    debug('_listen2: have a handle already');
  } else {
    debug('_listen2: create a handle');

    var rval = null;

    if (!address && typeof fd !== 'number') {
      rval = createServerHandle('::', port, 6, fd);

      if (typeof rval === 'number') {
        rval = null;
        address = '0.0.0.0';
        addressType = 4;
      } else {
        address = '::';
        addressType = 6;
      }
    }

    if (rval === null)
      rval = createServerHandle(address, port, addressType, fd);

    if (typeof rval === 'number') {
      var error = exceptionWithHostPort(rval, 'listen', address, port);
      process.nextTick(emitErrorNT, this, error);
      return;
    }
    this._handle = rval;
  }

  this._handle.onconnection = onconnection;
  this._handle.owner = this;

  var err = _listen(this._handle, backlog);

  if (err) {
    var ex = exceptionWithHostPort(err, 'listen', address, port);
    this._handle.close();
    this._handle = null;
    process.nextTick(emitErrorNT, this, ex);
    return;
  }

  // generate connection key, this should be unique to the connection
  this._connectionKey = addressType + ':' + address + ':' + port;

  // unref the handle if the server was unref'ed prior to listening
  if (this._unref)
    this.unref();

  process.nextTick(emitListeningNT, this);
};


function emitErrorNT(self, err) {
  self.emit('error', err);
}


function emitListeningNT(self) {
  // ensure handle hasn't closed
  if (self._handle)
    self.emit('listening');
}


function listen(self, address, port, addressType, backlog, fd, exclusive) {
  exclusive = !!exclusive;

  if (!cluster) cluster = require('cluster');

  if (cluster.isMaster || exclusive) {
    self._listen2(address, port, addressType, backlog, fd);
    return;
  }

  cluster._getServer(self, {
    address: address,
    port: port,
    addressType: addressType,
    fd: fd,
    flags: 0
  }, cb);

  function cb(err, handle) {
    // EADDRINUSE may not be reported until we call listen(). To complicate
    // matters, a failed bind() followed by listen() will implicitly bind to
    // a random port. Ergo, check that the socket is bound to the expected
    // port before calling listen().
    //
    // FIXME(bnoordhuis) Doesn't work for pipe handles, they don't have a
    // getsockname() method. Non-issue for now, the cluster module doesn't
    // really support pipes anyway.
    if (err === 0 && port > 0 && handle.getsockname) {
      var out = {};
      err = handle.getsockname(out);
      if (err === 0 && port !== out.port)
        err = uv.UV_EADDRINUSE;
    }

    if (err) {
      var ex = exceptionWithHostPort(err, 'bind', address, port);
      return self.emit('error', ex);
    }

    self._handle = handle;
    self._listen2(address, port, addressType, backlog, fd);
  }
}


Server.prototype.listen = function() {
  const args = new Array(arguments.length);
  for (var i = 0; i < arguments.length; i++)
    args[i] = arguments[i];
  // TODO(joyeecheung): use destructuring when V8 is fast enough
  const normalized = normalizeArgs(args);
  var options = normalized[0];
  const cb = normalized[1];

  var hasCallback = (cb !== null);
  if (hasCallback) {
    this.once('listening', cb);
  }
  const backlogFromArgs =
    // (handle, backlog) or (path, backlog) or (port, backlog)
    toNumber(args.length > 1 && args[1]) ||
    toNumber(args.length > 2 && args[2]);  // (port, host, backlog)

  options = options._handle || options.handle || options;
  // (handle[, backlog][, cb]) where handle is an object with a handle
  if (options instanceof TCP) {
    this._handle = options;
    listen(this, null, -1, -1, backlogFromArgs);
    return this;
  }
  // (handle[, backlog][, cb]) where handle is an object with a fd
  if (typeof options.fd === 'number' && options.fd >= 0) {
    listen(this, null, null, null, backlogFromArgs, options.fd);
    return this;
  }

  // ([port][, host][, backlog][, cb]) where port is omitted,
  // that is, listen() or listen(cb),
  // or (options[, cb]) where options.port is explicitly set as undefined,
  // bind to an arbitrary unused port
  if (args.length === 0 || typeof args[0] === 'function' ||
    (typeof options.port === 'undefined' && 'port' in options)) {
    options.port = 0;
  }
  // ([port][, host][, backlog][, cb]) where port is specified
  // or (options[, cb]) where options.port is specified
  // or if options.port is normalized as 0 before
  if (typeof options.port === 'number' || typeof options.port === 'string') {
    if (!isLegalPort(options.port)) {
      throw new RangeError('"port" argument must be >= 0 and < 65536');
    }
    const backlog = options.backlog || backlogFromArgs;
    // start TCP server listening on host:port
    if (options.host) {
      lookupAndListen(this, options.port | 0, options.host, backlog,
                      options.exclusive);
    } else { // Undefined host, listens on unspecified address
      listen(this, null, options.port | 0, 4, // addressType will be ignored
             backlog, undefined, options.exclusive);
    }
    return this;
  }

  // (path[, backlog][, cb]) or (options[, cb])
  // where path or options.path is a UNIX domain socket or Windows pipe
  if (options.path && isPipeName(options.path)) {
    const pipeName = this._pipeName = options.path;
    const backlog = options.backlog || backlogFromArgs;
    listen(this, pipeName, -1, -1, backlog, undefined, options.exclusive);
    return this;
  }

  throw new Error('Invalid listen argument: ' + util.inspect(options));
};

function lookupAndListen(self, port, address, backlog, exclusive) {
  require('dns').lookup(address, function doListening(err, ip, addressType) {
    if (err) {
      self.emit('error', err);
    } else {
      addressType = ip ? addressType : 4;
      listen(self, ip, port, addressType, backlog, undefined, exclusive);
    }
  });
}

Object.defineProperty(Server.prototype, 'listening', {
  get: function() {
    return !!this._handle;
  },
  configurable: true,
  enumerable: true
});

Server.prototype.address = function() {
  if (this._handle && this._handle.getsockname) {
    var out = {};
    this._handle.getsockname(out);
    // TODO(bnoordhuis) Check err and throw?
    return out;
  } else if (this._pipeName) {
    return this._pipeName;
  } else {
    return null;
  }
};

function onconnection(err, clientHandle) {
  var handle = this;
  var self = handle.owner;

  debug('onconnection');

  if (err) {
    self.emit('error', errnoException(err, 'accept'));
    return;
  }

  if (self.maxConnections && self._connections >= self.maxConnections) {
    clientHandle.close();
    return;
  }

  var socket = new Socket({
    handle: clientHandle,
    allowHalfOpen: self.allowHalfOpen,
    pauseOnCreate: self.pauseOnConnect
  });
  socket.readable = socket.writable = true;


  self._connections++;
  socket.server = self;
  socket._server = self;

  DTRACE_NET_SERVER_CONNECTION(socket);
  LTTNG_NET_SERVER_CONNECTION(socket);
  COUNTER_NET_SERVER_CONNECTION(socket);
  self.emit('connection', socket);
}


Server.prototype.getConnections = function(cb) {
  function end(err, connections) {
    process.nextTick(cb, err, connections);
  }

  if (!this._usingSlaves) {
    return end(null, this._connections);
  }

  // Poll slaves
  var left = this._slaves.length;
  var total = this._connections;

  function oncount(err, count) {
    if (err) {
      left = -1;
      return end(err);
    }

    total += count;
    if (--left === 0) return end(null, total);
  }

  for (var n = 0; n < this._slaves.length; n++) {
    this._slaves[n].getConnections(oncount);
  }
};


Server.prototype.close = function(cb) {
  function onSlaveClose() {
    if (--left !== 0) return;

    self._connections = 0;
    self._emitCloseIfDrained();
  }

  if (typeof cb === 'function') {
    if (!this._handle) {
      this.once('close', function close() {
        cb(new Error('Not running'));
      });
    } else {
      this.once('close', cb);
    }
  }

  if (this._handle) {
    this._handle.close();
    this._handle = null;
  }

  if (this._usingSlaves) {
    var self = this;
    var left = this._slaves.length;

    // Increment connections to be sure that, even if all sockets will be closed
    // during polling of slaves, `close` event will be emitted only once.
    this._connections++;

    // Poll slaves
    for (var n = 0; n < this._slaves.length; n++)
      this._slaves[n].close(onSlaveClose);
  } else {
    this._emitCloseIfDrained();
  }

  return this;
};

Server.prototype._emitCloseIfDrained = function() {
  debug('SERVER _emitCloseIfDrained');

  if (this._handle || this._connections) {
    debug('SERVER handle? %j   connections? %d',
          !!this._handle, this._connections);
    return;
  }

  process.nextTick(emitCloseNT, this);
};


function emitCloseNT(self) {
  debug('SERVER: emit close');
  self.emit('close');
}


Server.prototype.listenFD = internalUtil.deprecate(function(fd, type) {
  return this.listen({ fd: fd });
}, 'Server.listenFD is deprecated. Use Server.listen({fd: <number>}) instead.',
                                                   'DEP0021');

Server.prototype._setupSlave = function(socketList) {
  this._usingSlaves = true;
  this._slaves.push(socketList);
};

Server.prototype.ref = function() {
  this._unref = false;

  if (this._handle)
    this._handle.ref();

  return this;
};

Server.prototype.unref = function() {
  this._unref = true;

  if (this._handle)
    this._handle.unref();

  return this;
};

var _setSimultaneousAccepts;

if (process.platform === 'win32') {
  var simultaneousAccepts;

  _setSimultaneousAccepts = function(handle) {
    if (handle === undefined) {
      return;
    }

    if (simultaneousAccepts === undefined) {
      simultaneousAccepts = (process.env.NODE_MANY_ACCEPTS &&
                             process.env.NODE_MANY_ACCEPTS !== '0');
    }

    if (handle._simultaneousAccepts !== simultaneousAccepts) {
      handle.setSimultaneousAccepts(simultaneousAccepts);
      handle._simultaneousAccepts = simultaneousAccepts;
    }
  };
} else {
  _setSimultaneousAccepts = function(handle) {};
}

module.exports = {
  _createServerHandle: createServerHandle,
  _normalizeArgs: normalizeArgs,
  _setSimultaneousAccepts,
  connect,
  createConnection: connect,
  createServer,
  isIP: cares.isIP,
  isIPv4: cares.isIPv4,
  isIPv6: cares.isIPv6,
  Server,
  Socket,
  Stream: Socket, // Legacy naming
};
