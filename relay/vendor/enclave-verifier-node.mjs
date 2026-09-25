// enclave-verifier-node: built by verifier/node/build.mjs from the inputs in MANIFEST.json; do not edit by hand
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// node_modules/@freedomofpress/crypto-browser/dist/asn1/error.js
var ASN1ParseError, ASN1TypeError;
var init_error = __esm({
  "node_modules/@freedomofpress/crypto-browser/dist/asn1/error.js"() {
    ASN1ParseError = class extends Error {
    };
    ASN1TypeError = class extends Error {
    };
  }
});

// node_modules/@freedomofpress/crypto-browser/dist/asn1/tag.js
var UNIVERSAL_TAG, TAG_CLASS, ASN1Tag;
var init_tag = __esm({
  "node_modules/@freedomofpress/crypto-browser/dist/asn1/tag.js"() {
    init_error();
    UNIVERSAL_TAG = {
      BOOLEAN: 1,
      INTEGER: 2,
      BIT_STRING: 3,
      OCTET_STRING: 4,
      OBJECT_IDENTIFIER: 6,
      SEQUENCE: 16,
      SET: 17,
      PRINTABLE_STRING: 19,
      UTC_TIME: 23,
      GENERALIZED_TIME: 24
    };
    TAG_CLASS = {
      UNIVERSAL: 0,
      APPLICATION: 1,
      CONTEXT_SPECIFIC: 2,
      PRIVATE: 3
    };
    ASN1Tag = class {
      constructor(enc) {
        this.number = enc & 31;
        this.constructed = (enc & 32) === 32;
        this.class = enc >> 6;
        if (this.number === 31) {
          throw new ASN1ParseError("long form tags not supported");
        }
        if (this.class === TAG_CLASS.UNIVERSAL && this.number === 0) {
          throw new ASN1ParseError("unsupported tag 0x00");
        }
      }
      isUniversal() {
        return this.class === TAG_CLASS.UNIVERSAL;
      }
      isContextSpecific(num) {
        const res = this.class === TAG_CLASS.CONTEXT_SPECIFIC;
        return num !== void 0 ? res && this.number === num : res;
      }
      isBoolean() {
        return this.isUniversal() && this.number === UNIVERSAL_TAG.BOOLEAN;
      }
      isInteger() {
        return this.isUniversal() && this.number === UNIVERSAL_TAG.INTEGER;
      }
      isBitString() {
        return this.isUniversal() && this.number === UNIVERSAL_TAG.BIT_STRING;
      }
      isOctetString() {
        return this.isUniversal() && this.number === UNIVERSAL_TAG.OCTET_STRING;
      }
      isOID() {
        return this.isUniversal() && this.number === UNIVERSAL_TAG.OBJECT_IDENTIFIER;
      }
      isUTCTime() {
        return this.isUniversal() && this.number === UNIVERSAL_TAG.UTC_TIME;
      }
      isGeneralizedTime() {
        return this.isUniversal() && this.number === UNIVERSAL_TAG.GENERALIZED_TIME;
      }
      toDER() {
        return this.number | (this.constructed ? 32 : 0) | this.class << 6;
      }
    };
  }
});

// node_modules/@freedomofpress/crypto-browser/dist/asn1/length.js
function decodeLength(stream) {
  const buf = stream.getUint8();
  if ((buf & 128) === 0) {
    return buf;
  }
  const byteCount = buf & 127;
  if (byteCount > 6) {
    throw new ASN1ParseError("length exceeds 6 byte limit");
  }
  let len = 0;
  for (let i = 0; i < byteCount; i++) {
    len = len * 256 + stream.getUint8();
  }
  if (len === 0) {
    throw new ASN1ParseError("indefinite length encoding not supported");
  }
  return len;
}
function encodeLength(len) {
  if (len < 128) {
    return new Uint8Array([len]);
  }
  let val = BigInt(len);
  const bytes2 = [];
  while (val > 0n) {
    bytes2.unshift(Number(val & 255n));
    val = val >> 8n;
  }
  return new Uint8Array([128 | bytes2.length, ...bytes2]);
}
var init_length = __esm({
  "node_modules/@freedomofpress/crypto-browser/dist/asn1/length.js"() {
    init_error();
  }
});

// node_modules/@freedomofpress/crypto-browser/dist/encoding.js
function base64ToUint8Array(base64) {
  const binaryString = atob(base64);
  const length = binaryString.length;
  const bytes2 = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    bytes2[i] = binaryString.charCodeAt(i);
  }
  return bytes2;
}
function base64UrlToUint8Array(base64url) {
  let base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4 !== 0) {
    base64 += "=";
  }
  return base64ToUint8Array(base64);
}
function Uint8ArrayToBase64(uint8Array) {
  let binaryString = "";
  for (let i = 0; i < uint8Array.length; i++) {
    binaryString += String.fromCharCode(uint8Array[i]);
  }
  return btoa(binaryString);
}
function hexToUint8Array(hex3) {
  if (hex3.length % 2 !== 0) {
    throw new Error("Hex string must have an even length");
  }
  const length = hex3.length / 2;
  const uint8Array = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    uint8Array[i] = parseInt(hex3.slice(i * 2, i * 2 + 2), 16);
  }
  return uint8Array;
}
function Uint8ArrayToHex(data) {
  let hexString = "";
  for (let i = 0; i < data.length; i++) {
    let hex3 = data[i].toString(16);
    if (hex3.length === 1) {
      hex3 = "0" + hex3;
    }
    hexString += hex3;
  }
  return hexString;
}
function stringToUint8Array(str2) {
  const encoder = new TextEncoder();
  return encoder.encode(str2);
}
function Uint8ArrayToString(uint8Array) {
  const decoder = new TextDecoder("utf-8");
  return decoder.decode(uint8Array);
}
function readBigInt64BE(uint8Array, offset) {
  if (offset === void 0) {
    offset = 0;
  }
  const hex3 = Uint8ArrayToHex(uint8Array.slice(offset, offset + 8));
  return BigInt(`0x${hex3}`);
}
function base64Decode(str2) {
  return Uint8ArrayToString(base64ToUint8Array(str2));
}
function uint8ArrayEqual(a, b) {
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.byteLength; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}
var init_encoding = __esm({
  "node_modules/@freedomofpress/crypto-browser/dist/encoding.js"() {
  }
});

// node_modules/@freedomofpress/crypto-browser/dist/asn1/parse.js
function parseInteger(buf) {
  let pos = 0;
  const end = buf.length;
  let val = buf[pos];
  const neg = val > 127;
  const pad = neg ? 255 : 0;
  while (val == pad && ++pos < end) {
    val = buf[pos];
  }
  const len = end - pos;
  if (len === 0)
    return BigInt(neg ? -1 : 0);
  val = neg ? val - 256 : val;
  let n = BigInt(val);
  for (let i = pos + 1; i < end; ++i) {
    n = n * BigInt(256) + BigInt(buf[i]);
  }
  return n;
}
function parseStringASCII(buf) {
  return Uint8ArrayToString(buf);
}
function parseTime(buf, shortYear) {
  const timeStr = parseStringASCII(buf);
  const m = shortYear ? RE_TIME_SHORT_YEAR.exec(timeStr) : RE_TIME_LONG_YEAR.exec(timeStr);
  if (!m) {
    throw new Error("invalid time");
  }
  if (shortYear) {
    let year = Number(m[1]);
    year += year >= 50 ? 1900 : 2e3;
    m[1] = year.toString();
  }
  return /* @__PURE__ */ new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
}
function parseOID(buf) {
  let pos = 0;
  const end = buf.length;
  let n = buf[pos++];
  const first = Math.floor(n / 40);
  const second = n % 40;
  let oid2 = `${first}.${second}`;
  let val = 0;
  for (; pos < end; ++pos) {
    n = buf[pos];
    val = (val << 7) + (n & 127);
    if ((n & 128) === 0) {
      oid2 += `.${val}`;
      val = 0;
    }
  }
  return oid2;
}
function parseBoolean(buf) {
  return buf[0] !== 0;
}
function parseBitString(buf) {
  const unused = buf[0];
  const start = 1;
  const end = buf.length;
  const bits = [];
  for (let i = start; i < end; ++i) {
    const byte = buf[i];
    const skip = i === end - 1 ? unused : 0;
    for (let j = 7; j >= skip; --j) {
      bits.push(byte >> j & 1);
    }
  }
  return bits;
}
var RE_TIME_SHORT_YEAR, RE_TIME_LONG_YEAR;
var init_parse = __esm({
  "node_modules/@freedomofpress/crypto-browser/dist/asn1/parse.js"() {
    init_encoding();
    RE_TIME_SHORT_YEAR = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\.\d{3})?Z$/;
    RE_TIME_LONG_YEAR = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\.\d{3})?Z$/;
  }
});

// node_modules/@freedomofpress/crypto-browser/dist/stream.js
var StreamError, ByteStream;
var init_stream = __esm({
  "node_modules/@freedomofpress/crypto-browser/dist/stream.js"() {
    StreamError = class extends Error {
    };
    ByteStream = class _ByteStream {
      constructor(buffer) {
        this.start = 0;
        this.view = buffer ?? new Uint8Array(0);
      }
      get buffer() {
        return this.view.subarray(0, this.start);
      }
      get length() {
        return this.view.byteLength;
      }
      get position() {
        return this.start;
      }
      seek(position) {
        this.start = position;
      }
      slice(start, len) {
        const end = start + len;
        if (end > this.length) {
          throw new StreamError("request past end of buffer");
        }
        return this.view.subarray(start, end);
      }
      appendChar(char) {
        this.ensureCapacity(1);
        this.view[this.start] = char;
        this.start += 1;
      }
      appendUint16(num) {
        this.ensureCapacity(2);
        const value = new Uint16Array([num]);
        const view = new Uint8Array(value.buffer);
        this.view[this.start] = view[1];
        this.view[this.start + 1] = view[0];
        this.start += 2;
      }
      appendUint24(num) {
        this.ensureCapacity(3);
        const value = new Uint32Array([num]);
        const view = new Uint8Array(value.buffer);
        this.view[this.start] = view[2];
        this.view[this.start + 1] = view[1];
        this.view[this.start + 2] = view[0];
        this.start += 3;
      }
      appendView(view) {
        this.ensureCapacity(view.length);
        this.view.set(view, this.start);
        this.start += view.length;
      }
      getBlock(size) {
        if (size <= 0) {
          return new Uint8Array(0);
        }
        if (this.start + size > this.view.length) {
          throw new Error("request past end of buffer");
        }
        const result = this.view.subarray(this.start, this.start + size);
        this.start += size;
        return result;
      }
      getUint8() {
        return this.getBlock(1)[0];
      }
      getUint16() {
        const block = this.getBlock(2);
        return block[0] << 8 | block[1];
      }
      ensureCapacity(size) {
        if (this.start + size > this.view.byteLength) {
          const blockSize = _ByteStream.BLOCK_SIZE + (size > _ByteStream.BLOCK_SIZE ? size : 0);
          this.realloc(this.view.byteLength + blockSize);
        }
      }
      realloc(size) {
        const newView = new Uint8Array(size);
        newView.set(this.view);
        this.view = newView;
      }
    };
    ByteStream.BLOCK_SIZE = 1024;
  }
});

// node_modules/@freedomofpress/crypto-browser/dist/asn1/obj.js
function parseStream(stream) {
  const tag = new ASN1Tag(stream.getUint8());
  const len = decodeLength(stream);
  const value = stream.slice(stream.position, len);
  const start = stream.position;
  let subs = [];
  if (tag.constructed) {
    subs = collectSubs(stream, len);
  } else if (tag.isOctetString()) {
    try {
      subs = collectSubs(stream, len);
    } catch (e) {
    }
  }
  if (subs.length === 0) {
    stream.seek(start + len);
  }
  return new ASN1Obj(tag, value, subs);
}
function collectSubs(stream, len) {
  const end = stream.position + len;
  if (end > stream.length) {
    throw new ASN1ParseError("invalid length");
  }
  const subs = [];
  while (stream.position < end) {
    subs.push(parseStream(stream));
  }
  if (stream.position !== end) {
    throw new ASN1ParseError("invalid length");
  }
  return subs;
}
var ASN1Obj;
var init_obj = __esm({
  "node_modules/@freedomofpress/crypto-browser/dist/asn1/obj.js"() {
    init_stream();
    init_error();
    init_length();
    init_parse();
    init_tag();
    ASN1Obj = class {
      constructor(tag, value, subs) {
        this.tag = tag;
        this.value = value;
        this.subs = subs;
      }
      // Constructs an ASN.1 object from a Buffer of DER-encoded bytes.
      static parseBuffer(buf) {
        return parseStream(new ByteStream(buf));
      }
      toDER() {
        const valueStream = new ByteStream();
        if (this.subs.length > 0) {
          for (const sub of this.subs) {
            valueStream.appendView(sub.toDER());
          }
        } else {
          valueStream.appendView(this.value);
        }
        const value = valueStream.buffer;
        const obj2 = new ByteStream();
        obj2.appendChar(this.tag.toDER());
        obj2.appendView(encodeLength(value.length));
        obj2.appendView(value);
        return obj2.buffer;
      }
      /////////////////////////////////////////////////////////////////////////////
      // Convenience methods for parsing ASN.1 primitives into JS types
      // Returns the ASN.1 object's value as a boolean. Throws an error if the
      // object is not a boolean.
      toBoolean() {
        if (!this.tag.isBoolean()) {
          throw new ASN1TypeError("not a boolean");
        }
        return parseBoolean(this.value);
      }
      // Returns the ASN.1 object's value as a BigInt. Throws an error if the
      // object is not an integer.
      toInteger() {
        if (!this.tag.isInteger()) {
          throw new ASN1TypeError("not an integer");
        }
        return parseInteger(this.value);
      }
      // Returns the ASN.1 object's value as an OID string. Throws an error if the
      // object is not an OID.
      toOID() {
        if (!this.tag.isOID()) {
          throw new ASN1TypeError("not an OID");
        }
        return parseOID(this.value);
      }
      // Returns the ASN.1 object's value as a Date. Throws an error if the object
      // is not either a UTCTime or a GeneralizedTime.
      toDate() {
        switch (true) {
          case this.tag.isUTCTime():
            return parseTime(this.value, true);
          case this.tag.isGeneralizedTime():
            return parseTime(this.value, false);
          default:
            throw new ASN1TypeError("not a date");
        }
      }
      // Returns the ASN.1 object's value as a number[] where each number is the
      // value of a bit in the bit string. Throws an error if the object is not a
      // bit string.
      toBitString() {
        if (!this.tag.isBitString()) {
          throw new ASN1TypeError("not a bit string");
        }
        return parseBitString(this.value);
      }
    };
  }
});

// node_modules/@freedomofpress/crypto-browser/dist/pem.js
function toDER(certificate) {
  let der = "";
  certificate.split("\n").forEach((line) => {
    if (line.match(PEM_HEADER) || line.match(PEM_FOOTER)) {
      return;
    }
    der += line;
  });
  return base64ToUint8Array(der);
}
var PEM_HEADER, PEM_FOOTER;
var init_pem = __esm({
  "node_modules/@freedomofpress/crypto-browser/dist/pem.js"() {
    init_encoding();
    PEM_HEADER = /-----BEGIN (.*)-----/;
    PEM_FOOTER = /-----END (.*)-----/;
  }
});

// node_modules/@freedomofpress/crypto-browser/dist/canonicalize.js
function canonicalizeString(string) {
  const escapedString = string.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return '"' + escapedString + '"';
}
function canonicalize(object) {
  const buffer = [];
  if (typeof object === "string") {
    buffer.push(canonicalizeString(object));
  } else if (typeof object === "boolean") {
    buffer.push(JSON.stringify(object));
  } else if (Number.isInteger(object)) {
    buffer.push(JSON.stringify(object));
  } else if (object === null) {
    buffer.push(JSON.stringify(object));
  } else if (Array.isArray(object)) {
    buffer.push(LEFT_SQUARE_BRACKET);
    let first = true;
    object.forEach((element) => {
      if (!first) {
        buffer.push(COMMA);
      }
      first = false;
      buffer.push(canonicalize(element));
    });
    buffer.push(RIGHT_SQUARE_BRACKET);
  } else if (typeof object === "object") {
    buffer.push(LEFT_CURLY_BRACKET);
    let first = true;
    Object.keys(object).sort().forEach((property) => {
      if (!first) {
        buffer.push(COMMA);
      }
      first = false;
      buffer.push(canonicalizeString(property));
      buffer.push(COLON);
      buffer.push(canonicalize(object[property]));
    });
    buffer.push(RIGHT_CURLY_BRACKET);
  } else {
    throw new TypeError("cannot encode " + object);
  }
  return buffer.join("");
}
var COMMA, COLON, LEFT_SQUARE_BRACKET, RIGHT_SQUARE_BRACKET, LEFT_CURLY_BRACKET, RIGHT_CURLY_BRACKET;
var init_canonicalize = __esm({
  "node_modules/@freedomofpress/crypto-browser/dist/canonicalize.js"() {
    COMMA = ",";
    COLON = ":";
    LEFT_SQUARE_BRACKET = "[";
    RIGHT_SQUARE_BRACKET = "]";
    LEFT_CURLY_BRACKET = "{";
    RIGHT_CURLY_BRACKET = "}";
  }
});

// node_modules/@freedomofpress/crypto-browser/dist/asn1/index.js
var init_asn1 = __esm({
  "node_modules/@freedomofpress/crypto-browser/dist/asn1/index.js"() {
    init_obj();
  }
});

// node_modules/@freedomofpress/crypto-browser/dist/interfaces.js
var KeyTypes, EcdsaTypes, HashAlgorithms, RsaAlgorithms, RsaSchemes;
var init_interfaces = __esm({
  "node_modules/@freedomofpress/crypto-browser/dist/interfaces.js"() {
    (function(KeyTypes2) {
      KeyTypes2["Ecdsa"] = "ECDSA";
      KeyTypes2["Ed25519"] = "Ed25519";
      KeyTypes2["RSA"] = "RSA";
    })(KeyTypes || (KeyTypes = {}));
    (function(EcdsaTypes2) {
      EcdsaTypes2["P256"] = "P-256";
      EcdsaTypes2["P384"] = "P-384";
      EcdsaTypes2["P521"] = "P-521";
    })(EcdsaTypes || (EcdsaTypes = {}));
    (function(HashAlgorithms2) {
      HashAlgorithms2["SHA256"] = "SHA-256";
      HashAlgorithms2["SHA384"] = "SHA-384";
      HashAlgorithms2["SHA512"] = "SHA-512";
    })(HashAlgorithms || (HashAlgorithms = {}));
    (function(RsaAlgorithms2) {
      RsaAlgorithms2["PKCS1v15"] = "RSASSA-PKCS1-v1_5";
      RsaAlgorithms2["PSS"] = "RSA-PSS";
    })(RsaAlgorithms || (RsaAlgorithms = {}));
    (function(RsaSchemes2) {
      RsaSchemes2["PKCS1"] = "PKCS1";
      RsaSchemes2["RSAPKCS1"] = "RSAPKCS1";
    })(RsaSchemes || (RsaSchemes = {}));
  }
});

// node_modules/@noble/hashes/esm/cryptoNode.js
import * as nc from "node:crypto";
var crypto2;
var init_cryptoNode = __esm({
  "node_modules/@noble/hashes/esm/cryptoNode.js"() {
    crypto2 = nc && typeof nc === "object" && "webcrypto" in nc ? nc.webcrypto : nc && typeof nc === "object" && "randomBytes" in nc ? nc : void 0;
  }
});

// node_modules/@noble/hashes/esm/utils.js
function isBytes(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
}
function anumber(n) {
  if (!Number.isSafeInteger(n) || n < 0)
    throw new Error("positive integer expected, got " + n);
}
function abytes(b, ...lengths) {
  if (!isBytes(b))
    throw new Error("Uint8Array expected");
  if (lengths.length > 0 && !lengths.includes(b.length))
    throw new Error("Uint8Array expected of length " + lengths + ", got length=" + b.length);
}
function ahash(h) {
  if (typeof h !== "function" || typeof h.create !== "function")
    throw new Error("Hash should be wrapped by utils.createHasher");
  anumber(h.outputLen);
  anumber(h.blockLen);
}
function aexists(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("Hash instance has been destroyed");
  if (checkFinished && instance.finished)
    throw new Error("Hash#digest() has already been called");
}
function aoutput(out, instance) {
  abytes(out);
  const min = instance.outputLen;
  if (out.length < min) {
    throw new Error("digestInto() expects output buffer of length at least " + min);
  }
}
function clean(...arrays) {
  for (let i = 0; i < arrays.length; i++) {
    arrays[i].fill(0);
  }
}
function createView(arr) {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
function rotr(word, shift) {
  return word << 32 - shift | word >>> shift;
}
function utf8ToBytes(str2) {
  if (typeof str2 !== "string")
    throw new Error("string expected");
  return new Uint8Array(new TextEncoder().encode(str2));
}
function toBytes(data) {
  if (typeof data === "string")
    data = utf8ToBytes(data);
  abytes(data);
  return data;
}
function concatBytes(...arrays) {
  let sum = 0;
  for (let i = 0; i < arrays.length; i++) {
    const a = arrays[i];
    abytes(a);
    sum += a.length;
  }
  const res = new Uint8Array(sum);
  for (let i = 0, pad = 0; i < arrays.length; i++) {
    const a = arrays[i];
    res.set(a, pad);
    pad += a.length;
  }
  return res;
}
function createHasher(hashCons) {
  const hashC = (msg) => hashCons().update(toBytes(msg)).digest();
  const tmp = hashCons();
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.create = () => hashCons();
  return hashC;
}
function randomBytes(bytesLength = 32) {
  if (crypto2 && typeof crypto2.getRandomValues === "function") {
    return crypto2.getRandomValues(new Uint8Array(bytesLength));
  }
  if (crypto2 && typeof crypto2.randomBytes === "function") {
    return Uint8Array.from(crypto2.randomBytes(bytesLength));
  }
  throw new Error("crypto.getRandomValues must be defined");
}
var Hash;
var init_utils = __esm({
  "node_modules/@noble/hashes/esm/utils.js"() {
    init_cryptoNode();
    Hash = class {
    };
  }
});

// node_modules/@noble/hashes/esm/_md.js
function setBigUint64(view, byteOffset, value, isLE) {
  if (typeof view.setBigUint64 === "function")
    return view.setBigUint64(byteOffset, value, isLE);
  const _32n2 = BigInt(32);
  const _u32_max = BigInt(4294967295);
  const wh = Number(value >> _32n2 & _u32_max);
  const wl = Number(value & _u32_max);
  const h = isLE ? 4 : 0;
  const l = isLE ? 0 : 4;
  view.setUint32(byteOffset + h, wh, isLE);
  view.setUint32(byteOffset + l, wl, isLE);
}
function Chi(a, b, c) {
  return a & b ^ ~a & c;
}
function Maj(a, b, c) {
  return a & b ^ a & c ^ b & c;
}
var HashMD, SHA256_IV, SHA384_IV, SHA512_IV;
var init_md = __esm({
  "node_modules/@noble/hashes/esm/_md.js"() {
    init_utils();
    HashMD = class extends Hash {
      constructor(blockLen, outputLen, padOffset, isLE) {
        super();
        this.finished = false;
        this.length = 0;
        this.pos = 0;
        this.destroyed = false;
        this.blockLen = blockLen;
        this.outputLen = outputLen;
        this.padOffset = padOffset;
        this.isLE = isLE;
        this.buffer = new Uint8Array(blockLen);
        this.view = createView(this.buffer);
      }
      update(data) {
        aexists(this);
        data = toBytes(data);
        abytes(data);
        const { view, buffer, blockLen } = this;
        const len = data.length;
        for (let pos = 0; pos < len; ) {
          const take = Math.min(blockLen - this.pos, len - pos);
          if (take === blockLen) {
            const dataView = createView(data);
            for (; blockLen <= len - pos; pos += blockLen)
              this.process(dataView, pos);
            continue;
          }
          buffer.set(data.subarray(pos, pos + take), this.pos);
          this.pos += take;
          pos += take;
          if (this.pos === blockLen) {
            this.process(view, 0);
            this.pos = 0;
          }
        }
        this.length += data.length;
        this.roundClean();
        return this;
      }
      digestInto(out) {
        aexists(this);
        aoutput(out, this);
        this.finished = true;
        const { buffer, view, blockLen, isLE } = this;
        let { pos } = this;
        buffer[pos++] = 128;
        clean(this.buffer.subarray(pos));
        if (this.padOffset > blockLen - pos) {
          this.process(view, 0);
          pos = 0;
        }
        for (let i = pos; i < blockLen; i++)
          buffer[i] = 0;
        setBigUint64(view, blockLen - 8, BigInt(this.length * 8), isLE);
        this.process(view, 0);
        const oview = createView(out);
        const len = this.outputLen;
        if (len % 4)
          throw new Error("_sha2: outputLen should be aligned to 32bit");
        const outLen = len / 4;
        const state = this.get();
        if (outLen > state.length)
          throw new Error("_sha2: outputLen bigger than state");
        for (let i = 0; i < outLen; i++)
          oview.setUint32(4 * i, state[i], isLE);
      }
      digest() {
        const { buffer, outputLen } = this;
        this.digestInto(buffer);
        const res = buffer.slice(0, outputLen);
        this.destroy();
        return res;
      }
      _cloneInto(to) {
        to || (to = new this.constructor());
        to.set(...this.get());
        const { blockLen, buffer, length, finished, destroyed, pos } = this;
        to.destroyed = destroyed;
        to.finished = finished;
        to.length = length;
        to.pos = pos;
        if (length % blockLen)
          to.buffer.set(buffer);
        return to;
      }
      clone() {
        return this._cloneInto();
      }
    };
    SHA256_IV = /* @__PURE__ */ Uint32Array.from([
      1779033703,
      3144134277,
      1013904242,
      2773480762,
      1359893119,
      2600822924,
      528734635,
      1541459225
    ]);
    SHA384_IV = /* @__PURE__ */ Uint32Array.from([
      3418070365,
      3238371032,
      1654270250,
      914150663,
      2438529370,
      812702999,
      355462360,
      4144912697,
      1731405415,
      4290775857,
      2394180231,
      1750603025,
      3675008525,
      1694076839,
      1203062813,
      3204075428
    ]);
    SHA512_IV = /* @__PURE__ */ Uint32Array.from([
      1779033703,
      4089235720,
      3144134277,
      2227873595,
      1013904242,
      4271175723,
      2773480762,
      1595750129,
      1359893119,
      2917565137,
      2600822924,
      725511199,
      528734635,
      4215389547,
      1541459225,
      327033209
    ]);
  }
});

// node_modules/@noble/hashes/esm/_u64.js
function fromBig(n, le = false) {
  if (le)
    return { h: Number(n & U32_MASK64), l: Number(n >> _32n & U32_MASK64) };
  return { h: Number(n >> _32n & U32_MASK64) | 0, l: Number(n & U32_MASK64) | 0 };
}
function split(lst, le = false) {
  const len = lst.length;
  let Ah = new Uint32Array(len);
  let Al = new Uint32Array(len);
  for (let i = 0; i < len; i++) {
    const { h, l } = fromBig(lst[i], le);
    [Ah[i], Al[i]] = [h, l];
  }
  return [Ah, Al];
}
function add(Ah, Al, Bh, Bl) {
  const l = (Al >>> 0) + (Bl >>> 0);
  return { h: Ah + Bh + (l / 2 ** 32 | 0) | 0, l: l | 0 };
}
var U32_MASK64, _32n, shrSH, shrSL, rotrSH, rotrSL, rotrBH, rotrBL, add3L, add3H, add4L, add4H, add5L, add5H;
var init_u64 = __esm({
  "node_modules/@noble/hashes/esm/_u64.js"() {
    U32_MASK64 = /* @__PURE__ */ BigInt(2 ** 32 - 1);
    _32n = /* @__PURE__ */ BigInt(32);
    shrSH = (h, _l, s) => h >>> s;
    shrSL = (h, l, s) => h << 32 - s | l >>> s;
    rotrSH = (h, l, s) => h >>> s | l << 32 - s;
    rotrSL = (h, l, s) => h << 32 - s | l >>> s;
    rotrBH = (h, l, s) => h << 64 - s | l >>> s - 32;
    rotrBL = (h, l, s) => h >>> s - 32 | l << 64 - s;
    add3L = (Al, Bl, Cl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0);
    add3H = (low, Ah, Bh, Ch) => Ah + Bh + Ch + (low / 2 ** 32 | 0) | 0;
    add4L = (Al, Bl, Cl, Dl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0);
    add4H = (low, Ah, Bh, Ch, Dh) => Ah + Bh + Ch + Dh + (low / 2 ** 32 | 0) | 0;
    add5L = (Al, Bl, Cl, Dl, El) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0) + (El >>> 0);
    add5H = (low, Ah, Bh, Ch, Dh, Eh) => Ah + Bh + Ch + Dh + Eh + (low / 2 ** 32 | 0) | 0;
  }
});

// node_modules/@noble/hashes/esm/sha2.js
var SHA256_K, SHA256_W, SHA256, K512, SHA512_Kh, SHA512_Kl, SHA512_W_H, SHA512_W_L, SHA512, SHA384, sha2563, sha512, sha384;
var init_sha2 = __esm({
  "node_modules/@noble/hashes/esm/sha2.js"() {
    init_md();
    init_u64();
    init_utils();
    SHA256_K = /* @__PURE__ */ Uint32Array.from([
      1116352408,
      1899447441,
      3049323471,
      3921009573,
      961987163,
      1508970993,
      2453635748,
      2870763221,
      3624381080,
      310598401,
      607225278,
      1426881987,
      1925078388,
      2162078206,
      2614888103,
      3248222580,
      3835390401,
      4022224774,
      264347078,
      604807628,
      770255983,
      1249150122,
      1555081692,
      1996064986,
      2554220882,
      2821834349,
      2952996808,
      3210313671,
      3336571891,
      3584528711,
      113926993,
      338241895,
      666307205,
      773529912,
      1294757372,
      1396182291,
      1695183700,
      1986661051,
      2177026350,
      2456956037,
      2730485921,
      2820302411,
      3259730800,
      3345764771,
      3516065817,
      3600352804,
      4094571909,
      275423344,
      430227734,
      506948616,
      659060556,
      883997877,
      958139571,
      1322822218,
      1537002063,
      1747873779,
      1955562222,
      2024104815,
      2227730452,
      2361852424,
      2428436474,
      2756734187,
      3204031479,
      3329325298
    ]);
    SHA256_W = /* @__PURE__ */ new Uint32Array(64);
    SHA256 = class extends HashMD {
      constructor(outputLen = 32) {
        super(64, outputLen, 8, false);
        this.A = SHA256_IV[0] | 0;
        this.B = SHA256_IV[1] | 0;
        this.C = SHA256_IV[2] | 0;
        this.D = SHA256_IV[3] | 0;
        this.E = SHA256_IV[4] | 0;
        this.F = SHA256_IV[5] | 0;
        this.G = SHA256_IV[6] | 0;
        this.H = SHA256_IV[7] | 0;
      }
      get() {
        const { A, B, C, D, E, F, G, H } = this;
        return [A, B, C, D, E, F, G, H];
      }
      // prettier-ignore
      set(A, B, C, D, E, F, G, H) {
        this.A = A | 0;
        this.B = B | 0;
        this.C = C | 0;
        this.D = D | 0;
        this.E = E | 0;
        this.F = F | 0;
        this.G = G | 0;
        this.H = H | 0;
      }
      process(view, offset) {
        for (let i = 0; i < 16; i++, offset += 4)
          SHA256_W[i] = view.getUint32(offset, false);
        for (let i = 16; i < 64; i++) {
          const W15 = SHA256_W[i - 15];
          const W2 = SHA256_W[i - 2];
          const s0 = rotr(W15, 7) ^ rotr(W15, 18) ^ W15 >>> 3;
          const s1 = rotr(W2, 17) ^ rotr(W2, 19) ^ W2 >>> 10;
          SHA256_W[i] = s1 + SHA256_W[i - 7] + s0 + SHA256_W[i - 16] | 0;
        }
        let { A, B, C, D, E, F, G, H } = this;
        for (let i = 0; i < 64; i++) {
          const sigma1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25);
          const T1 = H + sigma1 + Chi(E, F, G) + SHA256_K[i] + SHA256_W[i] | 0;
          const sigma0 = rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22);
          const T2 = sigma0 + Maj(A, B, C) | 0;
          H = G;
          G = F;
          F = E;
          E = D + T1 | 0;
          D = C;
          C = B;
          B = A;
          A = T1 + T2 | 0;
        }
        A = A + this.A | 0;
        B = B + this.B | 0;
        C = C + this.C | 0;
        D = D + this.D | 0;
        E = E + this.E | 0;
        F = F + this.F | 0;
        G = G + this.G | 0;
        H = H + this.H | 0;
        this.set(A, B, C, D, E, F, G, H);
      }
      roundClean() {
        clean(SHA256_W);
      }
      destroy() {
        this.set(0, 0, 0, 0, 0, 0, 0, 0);
        clean(this.buffer);
      }
    };
    K512 = /* @__PURE__ */ (() => split([
      "0x428a2f98d728ae22",
      "0x7137449123ef65cd",
      "0xb5c0fbcfec4d3b2f",
      "0xe9b5dba58189dbbc",
      "0x3956c25bf348b538",
      "0x59f111f1b605d019",
      "0x923f82a4af194f9b",
      "0xab1c5ed5da6d8118",
      "0xd807aa98a3030242",
      "0x12835b0145706fbe",
      "0x243185be4ee4b28c",
      "0x550c7dc3d5ffb4e2",
      "0x72be5d74f27b896f",
      "0x80deb1fe3b1696b1",
      "0x9bdc06a725c71235",
      "0xc19bf174cf692694",
      "0xe49b69c19ef14ad2",
      "0xefbe4786384f25e3",
      "0x0fc19dc68b8cd5b5",
      "0x240ca1cc77ac9c65",
      "0x2de92c6f592b0275",
      "0x4a7484aa6ea6e483",
      "0x5cb0a9dcbd41fbd4",
      "0x76f988da831153b5",
      "0x983e5152ee66dfab",
      "0xa831c66d2db43210",
      "0xb00327c898fb213f",
      "0xbf597fc7beef0ee4",
      "0xc6e00bf33da88fc2",
      "0xd5a79147930aa725",
      "0x06ca6351e003826f",
      "0x142929670a0e6e70",
      "0x27b70a8546d22ffc",
      "0x2e1b21385c26c926",
      "0x4d2c6dfc5ac42aed",
      "0x53380d139d95b3df",
      "0x650a73548baf63de",
      "0x766a0abb3c77b2a8",
      "0x81c2c92e47edaee6",
      "0x92722c851482353b",
      "0xa2bfe8a14cf10364",
      "0xa81a664bbc423001",
      "0xc24b8b70d0f89791",
      "0xc76c51a30654be30",
      "0xd192e819d6ef5218",
      "0xd69906245565a910",
      "0xf40e35855771202a",
      "0x106aa07032bbd1b8",
      "0x19a4c116b8d2d0c8",
      "0x1e376c085141ab53",
      "0x2748774cdf8eeb99",
      "0x34b0bcb5e19b48a8",
      "0x391c0cb3c5c95a63",
      "0x4ed8aa4ae3418acb",
      "0x5b9cca4f7763e373",
      "0x682e6ff3d6b2b8a3",
      "0x748f82ee5defb2fc",
      "0x78a5636f43172f60",
      "0x84c87814a1f0ab72",
      "0x8cc702081a6439ec",
      "0x90befffa23631e28",
      "0xa4506cebde82bde9",
      "0xbef9a3f7b2c67915",
      "0xc67178f2e372532b",
      "0xca273eceea26619c",
      "0xd186b8c721c0c207",
      "0xeada7dd6cde0eb1e",
      "0xf57d4f7fee6ed178",
      "0x06f067aa72176fba",
      "0x0a637dc5a2c898a6",
      "0x113f9804bef90dae",
      "0x1b710b35131c471b",
      "0x28db77f523047d84",
      "0x32caab7b40c72493",
      "0x3c9ebe0a15c9bebc",
      "0x431d67c49c100d4c",
      "0x4cc5d4becb3e42b6",
      "0x597f299cfc657e2a",
      "0x5fcb6fab3ad6faec",
      "0x6c44198c4a475817"
    ].map((n) => BigInt(n))))();
    SHA512_Kh = /* @__PURE__ */ (() => K512[0])();
    SHA512_Kl = /* @__PURE__ */ (() => K512[1])();
    SHA512_W_H = /* @__PURE__ */ new Uint32Array(80);
    SHA512_W_L = /* @__PURE__ */ new Uint32Array(80);
    SHA512 = class extends HashMD {
      constructor(outputLen = 64) {
        super(128, outputLen, 16, false);
        this.Ah = SHA512_IV[0] | 0;
        this.Al = SHA512_IV[1] | 0;
        this.Bh = SHA512_IV[2] | 0;
        this.Bl = SHA512_IV[3] | 0;
        this.Ch = SHA512_IV[4] | 0;
        this.Cl = SHA512_IV[5] | 0;
        this.Dh = SHA512_IV[6] | 0;
        this.Dl = SHA512_IV[7] | 0;
        this.Eh = SHA512_IV[8] | 0;
        this.El = SHA512_IV[9] | 0;
        this.Fh = SHA512_IV[10] | 0;
        this.Fl = SHA512_IV[11] | 0;
        this.Gh = SHA512_IV[12] | 0;
        this.Gl = SHA512_IV[13] | 0;
        this.Hh = SHA512_IV[14] | 0;
        this.Hl = SHA512_IV[15] | 0;
      }
      // prettier-ignore
      get() {
        const { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
        return [Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl];
      }
      // prettier-ignore
      set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl) {
        this.Ah = Ah | 0;
        this.Al = Al | 0;
        this.Bh = Bh | 0;
        this.Bl = Bl | 0;
        this.Ch = Ch | 0;
        this.Cl = Cl | 0;
        this.Dh = Dh | 0;
        this.Dl = Dl | 0;
        this.Eh = Eh | 0;
        this.El = El | 0;
        this.Fh = Fh | 0;
        this.Fl = Fl | 0;
        this.Gh = Gh | 0;
        this.Gl = Gl | 0;
        this.Hh = Hh | 0;
        this.Hl = Hl | 0;
      }
      process(view, offset) {
        for (let i = 0; i < 16; i++, offset += 4) {
          SHA512_W_H[i] = view.getUint32(offset);
          SHA512_W_L[i] = view.getUint32(offset += 4);
        }
        for (let i = 16; i < 80; i++) {
          const W15h = SHA512_W_H[i - 15] | 0;
          const W15l = SHA512_W_L[i - 15] | 0;
          const s0h = rotrSH(W15h, W15l, 1) ^ rotrSH(W15h, W15l, 8) ^ shrSH(W15h, W15l, 7);
          const s0l = rotrSL(W15h, W15l, 1) ^ rotrSL(W15h, W15l, 8) ^ shrSL(W15h, W15l, 7);
          const W2h = SHA512_W_H[i - 2] | 0;
          const W2l = SHA512_W_L[i - 2] | 0;
          const s1h = rotrSH(W2h, W2l, 19) ^ rotrBH(W2h, W2l, 61) ^ shrSH(W2h, W2l, 6);
          const s1l = rotrSL(W2h, W2l, 19) ^ rotrBL(W2h, W2l, 61) ^ shrSL(W2h, W2l, 6);
          const SUMl = add4L(s0l, s1l, SHA512_W_L[i - 7], SHA512_W_L[i - 16]);
          const SUMh = add4H(SUMl, s0h, s1h, SHA512_W_H[i - 7], SHA512_W_H[i - 16]);
          SHA512_W_H[i] = SUMh | 0;
          SHA512_W_L[i] = SUMl | 0;
        }
        let { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
        for (let i = 0; i < 80; i++) {
          const sigma1h = rotrSH(Eh, El, 14) ^ rotrSH(Eh, El, 18) ^ rotrBH(Eh, El, 41);
          const sigma1l = rotrSL(Eh, El, 14) ^ rotrSL(Eh, El, 18) ^ rotrBL(Eh, El, 41);
          const CHIh = Eh & Fh ^ ~Eh & Gh;
          const CHIl = El & Fl ^ ~El & Gl;
          const T1ll = add5L(Hl, sigma1l, CHIl, SHA512_Kl[i], SHA512_W_L[i]);
          const T1h = add5H(T1ll, Hh, sigma1h, CHIh, SHA512_Kh[i], SHA512_W_H[i]);
          const T1l = T1ll | 0;
          const sigma0h = rotrSH(Ah, Al, 28) ^ rotrBH(Ah, Al, 34) ^ rotrBH(Ah, Al, 39);
          const sigma0l = rotrSL(Ah, Al, 28) ^ rotrBL(Ah, Al, 34) ^ rotrBL(Ah, Al, 39);
          const MAJh = Ah & Bh ^ Ah & Ch ^ Bh & Ch;
          const MAJl = Al & Bl ^ Al & Cl ^ Bl & Cl;
          Hh = Gh | 0;
          Hl = Gl | 0;
          Gh = Fh | 0;
          Gl = Fl | 0;
          Fh = Eh | 0;
          Fl = El | 0;
          ({ h: Eh, l: El } = add(Dh | 0, Dl | 0, T1h | 0, T1l | 0));
          Dh = Ch | 0;
          Dl = Cl | 0;
          Ch = Bh | 0;
          Cl = Bl | 0;
          Bh = Ah | 0;
          Bl = Al | 0;
          const All = add3L(T1l, sigma0l, MAJl);
          Ah = add3H(All, T1h, sigma0h, MAJh);
          Al = All | 0;
        }
        ({ h: Ah, l: Al } = add(this.Ah | 0, this.Al | 0, Ah | 0, Al | 0));
        ({ h: Bh, l: Bl } = add(this.Bh | 0, this.Bl | 0, Bh | 0, Bl | 0));
        ({ h: Ch, l: Cl } = add(this.Ch | 0, this.Cl | 0, Ch | 0, Cl | 0));
        ({ h: Dh, l: Dl } = add(this.Dh | 0, this.Dl | 0, Dh | 0, Dl | 0));
        ({ h: Eh, l: El } = add(this.Eh | 0, this.El | 0, Eh | 0, El | 0));
        ({ h: Fh, l: Fl } = add(this.Fh | 0, this.Fl | 0, Fh | 0, Fl | 0));
        ({ h: Gh, l: Gl } = add(this.Gh | 0, this.Gl | 0, Gh | 0, Gl | 0));
        ({ h: Hh, l: Hl } = add(this.Hh | 0, this.Hl | 0, Hh | 0, Hl | 0));
        this.set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl);
      }
      roundClean() {
        clean(SHA512_W_H, SHA512_W_L);
      }
      destroy() {
        clean(this.buffer);
        this.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
      }
    };
    SHA384 = class extends SHA512 {
      constructor() {
        super(48);
        this.Ah = SHA384_IV[0] | 0;
        this.Al = SHA384_IV[1] | 0;
        this.Bh = SHA384_IV[2] | 0;
        this.Bl = SHA384_IV[3] | 0;
        this.Ch = SHA384_IV[4] | 0;
        this.Cl = SHA384_IV[5] | 0;
        this.Dh = SHA384_IV[6] | 0;
        this.Dl = SHA384_IV[7] | 0;
        this.Eh = SHA384_IV[8] | 0;
        this.El = SHA384_IV[9] | 0;
        this.Fh = SHA384_IV[10] | 0;
        this.Fl = SHA384_IV[11] | 0;
        this.Gh = SHA384_IV[12] | 0;
        this.Gl = SHA384_IV[13] | 0;
        this.Hh = SHA384_IV[14] | 0;
        this.Hl = SHA384_IV[15] | 0;
      }
    };
    sha2563 = /* @__PURE__ */ createHasher(() => new SHA256());
    sha512 = /* @__PURE__ */ createHasher(() => new SHA512());
    sha384 = /* @__PURE__ */ createHasher(() => new SHA384());
  }
});

// node_modules/@noble/hashes/esm/hmac.js
var HMAC, hmac;
var init_hmac = __esm({
  "node_modules/@noble/hashes/esm/hmac.js"() {
    init_utils();
    HMAC = class extends Hash {
      constructor(hash, _key) {
        super();
        this.finished = false;
        this.destroyed = false;
        ahash(hash);
        const key = toBytes(_key);
        this.iHash = hash.create();
        if (typeof this.iHash.update !== "function")
          throw new Error("Expected instance of class which extends utils.Hash");
        this.blockLen = this.iHash.blockLen;
        this.outputLen = this.iHash.outputLen;
        const blockLen = this.blockLen;
        const pad = new Uint8Array(blockLen);
        pad.set(key.length > blockLen ? hash.create().update(key).digest() : key);
        for (let i = 0; i < pad.length; i++)
          pad[i] ^= 54;
        this.iHash.update(pad);
        this.oHash = hash.create();
        for (let i = 0; i < pad.length; i++)
          pad[i] ^= 54 ^ 92;
        this.oHash.update(pad);
        clean(pad);
      }
      update(buf) {
        aexists(this);
        this.iHash.update(buf);
        return this;
      }
      digestInto(out) {
        aexists(this);
        abytes(out, this.outputLen);
        this.finished = true;
        this.iHash.digestInto(out);
        this.oHash.update(out);
        this.oHash.digestInto(out);
        this.destroy();
      }
      digest() {
        const out = new Uint8Array(this.oHash.outputLen);
        this.digestInto(out);
        return out;
      }
      _cloneInto(to) {
        to || (to = Object.create(Object.getPrototypeOf(this), {}));
        const { oHash, iHash, finished, destroyed, blockLen, outputLen } = this;
        to = to;
        to.finished = finished;
        to.destroyed = destroyed;
        to.blockLen = blockLen;
        to.outputLen = outputLen;
        to.oHash = oHash._cloneInto(to.oHash);
        to.iHash = iHash._cloneInto(to.iHash);
        return to;
      }
      clone() {
        return this._cloneInto();
      }
      destroy() {
        this.destroyed = true;
        this.oHash.destroy();
        this.iHash.destroy();
      }
    };
    hmac = (hash, key, message) => new HMAC(hash, key).update(message).digest();
    hmac.create = (hash, key) => new HMAC(hash, key);
  }
});

// node_modules/@noble/curves/esm/abstract/utils.js
function isBytes2(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
}
function abytes2(item) {
  if (!isBytes2(item))
    throw new Error("Uint8Array expected");
}
function abool(title, value) {
  if (typeof value !== "boolean")
    throw new Error(title + " boolean expected, got " + value);
}
function numberToHexUnpadded(num) {
  const hex3 = num.toString(16);
  return hex3.length & 1 ? "0" + hex3 : hex3;
}
function hexToNumber(hex3) {
  if (typeof hex3 !== "string")
    throw new Error("hex string expected, got " + typeof hex3);
  return hex3 === "" ? _0n : BigInt("0x" + hex3);
}
function bytesToHex(bytes2) {
  abytes2(bytes2);
  if (hasHexBuiltin)
    return bytes2.toHex();
  let hex3 = "";
  for (let i = 0; i < bytes2.length; i++) {
    hex3 += hexes[bytes2[i]];
  }
  return hex3;
}
function asciiToBase16(ch) {
  if (ch >= asciis._0 && ch <= asciis._9)
    return ch - asciis._0;
  if (ch >= asciis.A && ch <= asciis.F)
    return ch - (asciis.A - 10);
  if (ch >= asciis.a && ch <= asciis.f)
    return ch - (asciis.a - 10);
  return;
}
function hexToBytes(hex3) {
  if (typeof hex3 !== "string")
    throw new Error("hex string expected, got " + typeof hex3);
  if (hasHexBuiltin)
    return Uint8Array.fromHex(hex3);
  const hl = hex3.length;
  const al = hl / 2;
  if (hl % 2)
    throw new Error("hex string expected, got unpadded hex of length " + hl);
  const array = new Uint8Array(al);
  for (let ai = 0, hi = 0; ai < al; ai++, hi += 2) {
    const n1 = asciiToBase16(hex3.charCodeAt(hi));
    const n2 = asciiToBase16(hex3.charCodeAt(hi + 1));
    if (n1 === void 0 || n2 === void 0) {
      const char = hex3[hi] + hex3[hi + 1];
      throw new Error('hex string expected, got non-hex character "' + char + '" at index ' + hi);
    }
    array[ai] = n1 * 16 + n2;
  }
  return array;
}
function bytesToNumberBE(bytes2) {
  return hexToNumber(bytesToHex(bytes2));
}
function bytesToNumberLE(bytes2) {
  abytes2(bytes2);
  return hexToNumber(bytesToHex(Uint8Array.from(bytes2).reverse()));
}
function numberToBytesBE(n, len) {
  return hexToBytes(n.toString(16).padStart(len * 2, "0"));
}
function numberToBytesLE(n, len) {
  return numberToBytesBE(n, len).reverse();
}
function ensureBytes(title, hex3, expectedLength) {
  let res;
  if (typeof hex3 === "string") {
    try {
      res = hexToBytes(hex3);
    } catch (e) {
      throw new Error(title + " must be hex string or Uint8Array, cause: " + e);
    }
  } else if (isBytes2(hex3)) {
    res = Uint8Array.from(hex3);
  } else {
    throw new Error(title + " must be hex string or Uint8Array");
  }
  const len = res.length;
  if (typeof expectedLength === "number" && len !== expectedLength)
    throw new Error(title + " of length " + expectedLength + " expected, got " + len);
  return res;
}
function concatBytes2(...arrays) {
  let sum = 0;
  for (let i = 0; i < arrays.length; i++) {
    const a = arrays[i];
    abytes2(a);
    sum += a.length;
  }
  const res = new Uint8Array(sum);
  for (let i = 0, pad = 0; i < arrays.length; i++) {
    const a = arrays[i];
    res.set(a, pad);
    pad += a.length;
  }
  return res;
}
function inRange(n, min, max) {
  return isPosBig(n) && isPosBig(min) && isPosBig(max) && min <= n && n < max;
}
function aInRange(title, n, min, max) {
  if (!inRange(n, min, max))
    throw new Error("expected valid " + title + ": " + min + " <= n < " + max + ", got " + n);
}
function bitLen(n) {
  let len;
  for (len = 0; n > _0n; n >>= _1n, len += 1)
    ;
  return len;
}
function createHmacDrbg(hashLen, qByteLen, hmacFn) {
  if (typeof hashLen !== "number" || hashLen < 2)
    throw new Error("hashLen must be a number");
  if (typeof qByteLen !== "number" || qByteLen < 2)
    throw new Error("qByteLen must be a number");
  if (typeof hmacFn !== "function")
    throw new Error("hmacFn must be a function");
  let v = u8n(hashLen);
  let k = u8n(hashLen);
  let i = 0;
  const reset = () => {
    v.fill(1);
    k.fill(0);
    i = 0;
  };
  const h = (...b) => hmacFn(k, v, ...b);
  const reseed = (seed = u8n(0)) => {
    k = h(u8fr([0]), seed);
    v = h();
    if (seed.length === 0)
      return;
    k = h(u8fr([1]), seed);
    v = h();
  };
  const gen = () => {
    if (i++ >= 1e3)
      throw new Error("drbg: tried 1000 values");
    let len = 0;
    const out = [];
    while (len < qByteLen) {
      v = h();
      const sl = v.slice();
      out.push(sl);
      len += v.length;
    }
    return concatBytes2(...out);
  };
  const genUntil = (seed, pred) => {
    reset();
    reseed(seed);
    let res = void 0;
    while (!(res = pred(gen())))
      reseed();
    reset();
    return res;
  };
  return genUntil;
}
function validateObject(object, validators, optValidators = {}) {
  const checkField = (fieldName, type, isOptional) => {
    const checkVal = validatorFns[type];
    if (typeof checkVal !== "function")
      throw new Error("invalid validator function");
    const val = object[fieldName];
    if (isOptional && val === void 0)
      return;
    if (!checkVal(val, object)) {
      throw new Error("param " + String(fieldName) + " is invalid. Expected " + type + ", got " + val);
    }
  };
  for (const [fieldName, type] of Object.entries(validators))
    checkField(fieldName, type, false);
  for (const [fieldName, type] of Object.entries(optValidators))
    checkField(fieldName, type, true);
  return object;
}
function memoized(fn) {
  const map = /* @__PURE__ */ new WeakMap();
  return (arg, ...args) => {
    const val = map.get(arg);
    if (val !== void 0)
      return val;
    const computed = fn(arg, ...args);
    map.set(arg, computed);
    return computed;
  };
}
var _0n, _1n, hasHexBuiltin, hexes, asciis, isPosBig, bitMask, u8n, u8fr, validatorFns;
var init_utils2 = __esm({
  "node_modules/@noble/curves/esm/abstract/utils.js"() {
    _0n = /* @__PURE__ */ BigInt(0);
    _1n = /* @__PURE__ */ BigInt(1);
    hasHexBuiltin = // @ts-ignore
    typeof Uint8Array.from([]).toHex === "function" && typeof Uint8Array.fromHex === "function";
    hexes = /* @__PURE__ */ Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
    asciis = { _0: 48, _9: 57, A: 65, F: 70, a: 97, f: 102 };
    isPosBig = (n) => typeof n === "bigint" && _0n <= n;
    bitMask = (n) => (_1n << BigInt(n)) - _1n;
    u8n = (len) => new Uint8Array(len);
    u8fr = (arr) => Uint8Array.from(arr);
    validatorFns = {
      bigint: (val) => typeof val === "bigint",
      function: (val) => typeof val === "function",
      boolean: (val) => typeof val === "boolean",
      string: (val) => typeof val === "string",
      stringOrUint8Array: (val) => typeof val === "string" || isBytes2(val),
      isSafeInteger: (val) => Number.isSafeInteger(val),
      array: (val) => Array.isArray(val),
      field: (val, object) => object.Fp.isValid(val),
      hash: (val) => typeof val === "function" && Number.isSafeInteger(val.outputLen)
    };
  }
});

// node_modules/@noble/curves/esm/abstract/modular.js
function mod(a, b) {
  const result = a % b;
  return result >= _0n2 ? result : b + result;
}
function pow2(x, power, modulo) {
  let res = x;
  while (power-- > _0n2) {
    res *= res;
    res %= modulo;
  }
  return res;
}
function invert(number, modulo) {
  if (number === _0n2)
    throw new Error("invert: expected non-zero number");
  if (modulo <= _0n2)
    throw new Error("invert: expected positive modulus, got " + modulo);
  let a = mod(number, modulo);
  let b = modulo;
  let x = _0n2, y = _1n2, u = _1n2, v = _0n2;
  while (a !== _0n2) {
    const q = b / a;
    const r = b % a;
    const m = x - u * q;
    const n = y - v * q;
    b = a, a = r, x = u, y = v, u = m, v = n;
  }
  const gcd = b;
  if (gcd !== _1n2)
    throw new Error("invert: does not exist");
  return mod(x, modulo);
}
function sqrt3mod4(Fp2, n) {
  const p1div4 = (Fp2.ORDER + _1n2) / _4n;
  const root = Fp2.pow(n, p1div4);
  if (!Fp2.eql(Fp2.sqr(root), n))
    throw new Error("Cannot find square root");
  return root;
}
function sqrt5mod8(Fp2, n) {
  const p5div8 = (Fp2.ORDER - _5n) / _8n;
  const n2 = Fp2.mul(n, _2n);
  const v = Fp2.pow(n2, p5div8);
  const nv = Fp2.mul(n, v);
  const i = Fp2.mul(Fp2.mul(nv, _2n), v);
  const root = Fp2.mul(nv, Fp2.sub(i, Fp2.ONE));
  if (!Fp2.eql(Fp2.sqr(root), n))
    throw new Error("Cannot find square root");
  return root;
}
function tonelliShanks(P) {
  if (P < BigInt(3))
    throw new Error("sqrt is not defined for small field");
  let Q = P - _1n2;
  let S = 0;
  while (Q % _2n === _0n2) {
    Q /= _2n;
    S++;
  }
  let Z = _2n;
  const _Fp = Field(P);
  while (FpLegendre(_Fp, Z) === 1) {
    if (Z++ > 1e3)
      throw new Error("Cannot find square root: probably non-prime P");
  }
  if (S === 1)
    return sqrt3mod4;
  let cc = _Fp.pow(Z, Q);
  const Q1div2 = (Q + _1n2) / _2n;
  return function tonelliSlow(Fp2, n) {
    if (Fp2.is0(n))
      return n;
    if (FpLegendre(Fp2, n) !== 1)
      throw new Error("Cannot find square root");
    let M = S;
    let c = Fp2.mul(Fp2.ONE, cc);
    let t = Fp2.pow(n, Q);
    let R = Fp2.pow(n, Q1div2);
    while (!Fp2.eql(t, Fp2.ONE)) {
      if (Fp2.is0(t))
        return Fp2.ZERO;
      let i = 1;
      let t_tmp = Fp2.sqr(t);
      while (!Fp2.eql(t_tmp, Fp2.ONE)) {
        i++;
        t_tmp = Fp2.sqr(t_tmp);
        if (i === M)
          throw new Error("Cannot find square root");
      }
      const exponent = _1n2 << BigInt(M - i - 1);
      const b = Fp2.pow(c, exponent);
      M = i;
      c = Fp2.sqr(b);
      t = Fp2.mul(t, c);
      R = Fp2.mul(R, b);
    }
    return R;
  };
}
function FpSqrt(P) {
  if (P % _4n === _3n)
    return sqrt3mod4;
  if (P % _8n === _5n)
    return sqrt5mod8;
  return tonelliShanks(P);
}
function validateField(field) {
  const initial = {
    ORDER: "bigint",
    MASK: "bigint",
    BYTES: "isSafeInteger",
    BITS: "isSafeInteger"
  };
  const opts = FIELD_FIELDS.reduce((map, val) => {
    map[val] = "function";
    return map;
  }, initial);
  return validateObject(field, opts);
}
function FpPow(Fp2, num, power) {
  if (power < _0n2)
    throw new Error("invalid exponent, negatives unsupported");
  if (power === _0n2)
    return Fp2.ONE;
  if (power === _1n2)
    return num;
  let p = Fp2.ONE;
  let d = num;
  while (power > _0n2) {
    if (power & _1n2)
      p = Fp2.mul(p, d);
    d = Fp2.sqr(d);
    power >>= _1n2;
  }
  return p;
}
function FpInvertBatch(Fp2, nums, passZero = false) {
  const inverted = new Array(nums.length).fill(passZero ? Fp2.ZERO : void 0);
  const multipliedAcc = nums.reduce((acc, num, i) => {
    if (Fp2.is0(num))
      return acc;
    inverted[i] = acc;
    return Fp2.mul(acc, num);
  }, Fp2.ONE);
  const invertedAcc = Fp2.inv(multipliedAcc);
  nums.reduceRight((acc, num, i) => {
    if (Fp2.is0(num))
      return acc;
    inverted[i] = Fp2.mul(acc, inverted[i]);
    return Fp2.mul(acc, num);
  }, invertedAcc);
  return inverted;
}
function FpLegendre(Fp2, n) {
  const p1mod2 = (Fp2.ORDER - _1n2) / _2n;
  const powered = Fp2.pow(n, p1mod2);
  const yes = Fp2.eql(powered, Fp2.ONE);
  const zero = Fp2.eql(powered, Fp2.ZERO);
  const no = Fp2.eql(powered, Fp2.neg(Fp2.ONE));
  if (!yes && !zero && !no)
    throw new Error("invalid Legendre symbol result");
  return yes ? 1 : zero ? 0 : -1;
}
function nLength(n, nBitLength) {
  if (nBitLength !== void 0)
    anumber(nBitLength);
  const _nBitLength = nBitLength !== void 0 ? nBitLength : n.toString(2).length;
  const nByteLength = Math.ceil(_nBitLength / 8);
  return { nBitLength: _nBitLength, nByteLength };
}
function Field(ORDER, bitLen2, isLE = false, redef = {}) {
  if (ORDER <= _0n2)
    throw new Error("invalid field: expected ORDER > 0, got " + ORDER);
  const { nBitLength: BITS, nByteLength: BYTES } = nLength(ORDER, bitLen2);
  if (BYTES > 2048)
    throw new Error("invalid field: expected ORDER of <= 2048 bytes");
  let sqrtP;
  const f = Object.freeze({
    ORDER,
    isLE,
    BITS,
    BYTES,
    MASK: bitMask(BITS),
    ZERO: _0n2,
    ONE: _1n2,
    create: (num) => mod(num, ORDER),
    isValid: (num) => {
      if (typeof num !== "bigint")
        throw new Error("invalid field element: expected bigint, got " + typeof num);
      return _0n2 <= num && num < ORDER;
    },
    is0: (num) => num === _0n2,
    isOdd: (num) => (num & _1n2) === _1n2,
    neg: (num) => mod(-num, ORDER),
    eql: (lhs, rhs) => lhs === rhs,
    sqr: (num) => mod(num * num, ORDER),
    add: (lhs, rhs) => mod(lhs + rhs, ORDER),
    sub: (lhs, rhs) => mod(lhs - rhs, ORDER),
    mul: (lhs, rhs) => mod(lhs * rhs, ORDER),
    pow: (num, power) => FpPow(f, num, power),
    div: (lhs, rhs) => mod(lhs * invert(rhs, ORDER), ORDER),
    // Same as above, but doesn't normalize
    sqrN: (num) => num * num,
    addN: (lhs, rhs) => lhs + rhs,
    subN: (lhs, rhs) => lhs - rhs,
    mulN: (lhs, rhs) => lhs * rhs,
    inv: (num) => invert(num, ORDER),
    sqrt: redef.sqrt || ((n) => {
      if (!sqrtP)
        sqrtP = FpSqrt(ORDER);
      return sqrtP(f, n);
    }),
    toBytes: (num) => isLE ? numberToBytesLE(num, BYTES) : numberToBytesBE(num, BYTES),
    fromBytes: (bytes2) => {
      if (bytes2.length !== BYTES)
        throw new Error("Field.fromBytes: expected " + BYTES + " bytes, got " + bytes2.length);
      return isLE ? bytesToNumberLE(bytes2) : bytesToNumberBE(bytes2);
    },
    // TODO: we don't need it here, move out to separate fn
    invertBatch: (lst) => FpInvertBatch(f, lst),
    // We can't move this out because Fp6, Fp12 implement it
    // and it's unclear what to return in there.
    cmov: (a, b, c) => c ? b : a
  });
  return Object.freeze(f);
}
function getFieldBytesLength(fieldOrder) {
  if (typeof fieldOrder !== "bigint")
    throw new Error("field order must be bigint");
  const bitLength2 = fieldOrder.toString(2).length;
  return Math.ceil(bitLength2 / 8);
}
function getMinHashLength(fieldOrder) {
  const length = getFieldBytesLength(fieldOrder);
  return length + Math.ceil(length / 2);
}
function mapHashToField(key, fieldOrder, isLE = false) {
  const len = key.length;
  const fieldLen = getFieldBytesLength(fieldOrder);
  const minLen = getMinHashLength(fieldOrder);
  if (len < 16 || len < minLen || len > 1024)
    throw new Error("expected " + minLen + "-1024 bytes of input, got " + len);
  const num = isLE ? bytesToNumberLE(key) : bytesToNumberBE(key);
  const reduced = mod(num, fieldOrder - _1n2) + _1n2;
  return isLE ? numberToBytesLE(reduced, fieldLen) : numberToBytesBE(reduced, fieldLen);
}
var _0n2, _1n2, _2n, _3n, _4n, _5n, _8n, isNegativeLE, FIELD_FIELDS;
var init_modular = __esm({
  "node_modules/@noble/curves/esm/abstract/modular.js"() {
    init_utils();
    init_utils2();
    _0n2 = BigInt(0);
    _1n2 = BigInt(1);
    _2n = /* @__PURE__ */ BigInt(2);
    _3n = /* @__PURE__ */ BigInt(3);
    _4n = /* @__PURE__ */ BigInt(4);
    _5n = /* @__PURE__ */ BigInt(5);
    _8n = /* @__PURE__ */ BigInt(8);
    isNegativeLE = (num, modulo) => (mod(num, modulo) & _1n2) === _1n2;
    FIELD_FIELDS = [
      "create",
      "isValid",
      "is0",
      "neg",
      "inv",
      "sqrt",
      "sqr",
      "eql",
      "add",
      "sub",
      "mul",
      "pow",
      "div",
      "addN",
      "subN",
      "mulN",
      "sqrN"
    ];
  }
});

// node_modules/@noble/curves/esm/abstract/curve.js
function constTimeNegate(condition, item) {
  const neg = item.negate();
  return condition ? neg : item;
}
function validateW(W, bits) {
  if (!Number.isSafeInteger(W) || W <= 0 || W > bits)
    throw new Error("invalid window size, expected [1.." + bits + "], got W=" + W);
}
function calcWOpts(W, scalarBits) {
  validateW(W, scalarBits);
  const windows = Math.ceil(scalarBits / W) + 1;
  const windowSize = 2 ** (W - 1);
  const maxNumber = 2 ** W;
  const mask = bitMask(W);
  const shiftBy = BigInt(W);
  return { windows, windowSize, mask, maxNumber, shiftBy };
}
function calcOffsets(n, window, wOpts) {
  const { windowSize, mask, maxNumber, shiftBy } = wOpts;
  let wbits = Number(n & mask);
  let nextN = n >> shiftBy;
  if (wbits > windowSize) {
    wbits -= maxNumber;
    nextN += _1n3;
  }
  const offsetStart = window * windowSize;
  const offset = offsetStart + Math.abs(wbits) - 1;
  const isZero = wbits === 0;
  const isNeg = wbits < 0;
  const isNegF = window % 2 !== 0;
  const offsetF = offsetStart;
  return { nextN, offset, isZero, isNeg, isNegF, offsetF };
}
function validateMSMPoints(points, c) {
  if (!Array.isArray(points))
    throw new Error("array expected");
  points.forEach((p, i) => {
    if (!(p instanceof c))
      throw new Error("invalid point at index " + i);
  });
}
function validateMSMScalars(scalars, field) {
  if (!Array.isArray(scalars))
    throw new Error("array of scalars expected");
  scalars.forEach((s, i) => {
    if (!field.isValid(s))
      throw new Error("invalid scalar at index " + i);
  });
}
function getW(P) {
  return pointWindowSizes.get(P) || 1;
}
function wNAF(c, bits) {
  return {
    constTimeNegate,
    hasPrecomputes(elm) {
      return getW(elm) !== 1;
    },
    // non-const time multiplication ladder
    unsafeLadder(elm, n, p = c.ZERO) {
      let d = elm;
      while (n > _0n3) {
        if (n & _1n3)
          p = p.add(d);
        d = d.double();
        n >>= _1n3;
      }
      return p;
    },
    /**
     * Creates a wNAF precomputation window. Used for caching.
     * Default window size is set by `utils.precompute()` and is equal to 8.
     * Number of precomputed points depends on the curve size:
     * 2^(𝑊−1) * (Math.ceil(𝑛 / 𝑊) + 1), where:
     * - 𝑊 is the window size
     * - 𝑛 is the bitlength of the curve order.
     * For a 256-bit curve and window size 8, the number of precomputed points is 128 * 33 = 4224.
     * @param elm Point instance
     * @param W window size
     * @returns precomputed point tables flattened to a single array
     */
    precomputeWindow(elm, W) {
      const { windows, windowSize } = calcWOpts(W, bits);
      const points = [];
      let p = elm;
      let base = p;
      for (let window = 0; window < windows; window++) {
        base = p;
        points.push(base);
        for (let i = 1; i < windowSize; i++) {
          base = base.add(p);
          points.push(base);
        }
        p = base.double();
      }
      return points;
    },
    /**
     * Implements ec multiplication using precomputed tables and w-ary non-adjacent form.
     * @param W window size
     * @param precomputes precomputed tables
     * @param n scalar (we don't check here, but should be less than curve order)
     * @returns real and fake (for const-time) points
     */
    wNAF(W, precomputes, n) {
      let p = c.ZERO;
      let f = c.BASE;
      const wo = calcWOpts(W, bits);
      for (let window = 0; window < wo.windows; window++) {
        const { nextN, offset, isZero, isNeg, isNegF, offsetF } = calcOffsets(n, window, wo);
        n = nextN;
        if (isZero) {
          f = f.add(constTimeNegate(isNegF, precomputes[offsetF]));
        } else {
          p = p.add(constTimeNegate(isNeg, precomputes[offset]));
        }
      }
      return { p, f };
    },
    /**
     * Implements ec unsafe (non const-time) multiplication using precomputed tables and w-ary non-adjacent form.
     * @param W window size
     * @param precomputes precomputed tables
     * @param n scalar (we don't check here, but should be less than curve order)
     * @param acc accumulator point to add result of multiplication
     * @returns point
     */
    wNAFUnsafe(W, precomputes, n, acc = c.ZERO) {
      const wo = calcWOpts(W, bits);
      for (let window = 0; window < wo.windows; window++) {
        if (n === _0n3)
          break;
        const { nextN, offset, isZero, isNeg } = calcOffsets(n, window, wo);
        n = nextN;
        if (isZero) {
          continue;
        } else {
          const item = precomputes[offset];
          acc = acc.add(isNeg ? item.negate() : item);
        }
      }
      return acc;
    },
    getPrecomputes(W, P, transform) {
      let comp = pointPrecomputes.get(P);
      if (!comp) {
        comp = this.precomputeWindow(P, W);
        if (W !== 1)
          pointPrecomputes.set(P, transform(comp));
      }
      return comp;
    },
    wNAFCached(P, n, transform) {
      const W = getW(P);
      return this.wNAF(W, this.getPrecomputes(W, P, transform), n);
    },
    wNAFCachedUnsafe(P, n, transform, prev) {
      const W = getW(P);
      if (W === 1)
        return this.unsafeLadder(P, n, prev);
      return this.wNAFUnsafe(W, this.getPrecomputes(W, P, transform), n, prev);
    },
    // We calculate precomputes for elliptic curve point multiplication
    // using windowed method. This specifies window size and
    // stores precomputed values. Usually only base point would be precomputed.
    setWindowSize(P, W) {
      validateW(W, bits);
      pointWindowSizes.set(P, W);
      pointPrecomputes.delete(P);
    }
  };
}
function pippenger(c, fieldN, points, scalars) {
  validateMSMPoints(points, c);
  validateMSMScalars(scalars, fieldN);
  const plength = points.length;
  const slength = scalars.length;
  if (plength !== slength)
    throw new Error("arrays of points and scalars must have equal length");
  const zero = c.ZERO;
  const wbits = bitLen(BigInt(plength));
  let windowSize = 1;
  if (wbits > 12)
    windowSize = wbits - 3;
  else if (wbits > 4)
    windowSize = wbits - 2;
  else if (wbits > 0)
    windowSize = 2;
  const MASK = bitMask(windowSize);
  const buckets = new Array(Number(MASK) + 1).fill(zero);
  const lastBits = Math.floor((fieldN.BITS - 1) / windowSize) * windowSize;
  let sum = zero;
  for (let i = lastBits; i >= 0; i -= windowSize) {
    buckets.fill(zero);
    for (let j = 0; j < slength; j++) {
      const scalar = scalars[j];
      const wbits2 = Number(scalar >> BigInt(i) & MASK);
      buckets[wbits2] = buckets[wbits2].add(points[j]);
    }
    let resI = zero;
    for (let j = buckets.length - 1, sumI = zero; j > 0; j--) {
      sumI = sumI.add(buckets[j]);
      resI = resI.add(sumI);
    }
    sum = sum.add(resI);
    if (i !== 0)
      for (let j = 0; j < windowSize; j++)
        sum = sum.double();
  }
  return sum;
}
function validateBasic(curve) {
  validateField(curve.Fp);
  validateObject(curve, {
    n: "bigint",
    h: "bigint",
    Gx: "field",
    Gy: "field"
  }, {
    nBitLength: "isSafeInteger",
    nByteLength: "isSafeInteger"
  });
  return Object.freeze({
    ...nLength(curve.n, curve.nBitLength),
    ...curve,
    ...{ p: curve.Fp.ORDER }
  });
}
var _0n3, _1n3, pointPrecomputes, pointWindowSizes;
var init_curve = __esm({
  "node_modules/@noble/curves/esm/abstract/curve.js"() {
    init_modular();
    init_utils2();
    _0n3 = BigInt(0);
    _1n3 = BigInt(1);
    pointPrecomputes = /* @__PURE__ */ new WeakMap();
    pointWindowSizes = /* @__PURE__ */ new WeakMap();
  }
});

// node_modules/@noble/curves/esm/abstract/weierstrass.js
function validateSigVerOpts(opts) {
  if (opts.lowS !== void 0)
    abool("lowS", opts.lowS);
  if (opts.prehash !== void 0)
    abool("prehash", opts.prehash);
}
function validatePointOpts(curve) {
  const opts = validateBasic(curve);
  validateObject(opts, {
    a: "field",
    b: "field"
  }, {
    allowInfinityPoint: "boolean",
    allowedPrivateKeyLengths: "array",
    clearCofactor: "function",
    fromBytes: "function",
    isTorsionFree: "function",
    toBytes: "function",
    wrapPrivateKey: "boolean"
  });
  const { endo, Fp: Fp2, a } = opts;
  if (endo) {
    if (!Fp2.eql(a, Fp2.ZERO)) {
      throw new Error("invalid endo: CURVE.a must be 0");
    }
    if (typeof endo !== "object" || typeof endo.beta !== "bigint" || typeof endo.splitScalar !== "function") {
      throw new Error('invalid endo: expected "beta": bigint and "splitScalar": function');
    }
  }
  return Object.freeze({ ...opts });
}
function numToSizedHex(num, size) {
  return bytesToHex(numberToBytesBE(num, size));
}
function weierstrassPoints(opts) {
  const CURVE = validatePointOpts(opts);
  const { Fp: Fp2 } = CURVE;
  const Fn = Field(CURVE.n, CURVE.nBitLength);
  const toBytes2 = CURVE.toBytes || ((_c, point, _isCompressed) => {
    const a = point.toAffine();
    return concatBytes2(Uint8Array.from([4]), Fp2.toBytes(a.x), Fp2.toBytes(a.y));
  });
  const fromBytes = CURVE.fromBytes || ((bytes2) => {
    const tail = bytes2.subarray(1);
    const x = Fp2.fromBytes(tail.subarray(0, Fp2.BYTES));
    const y = Fp2.fromBytes(tail.subarray(Fp2.BYTES, 2 * Fp2.BYTES));
    return { x, y };
  });
  function weierstrassEquation(x) {
    const { a, b } = CURVE;
    const x2 = Fp2.sqr(x);
    const x3 = Fp2.mul(x2, x);
    return Fp2.add(Fp2.add(x3, Fp2.mul(x, a)), b);
  }
  function isValidXY(x, y) {
    const left = Fp2.sqr(y);
    const right = weierstrassEquation(x);
    return Fp2.eql(left, right);
  }
  if (!isValidXY(CURVE.Gx, CURVE.Gy))
    throw new Error("bad curve params: generator point");
  const _4a3 = Fp2.mul(Fp2.pow(CURVE.a, _3n2), _4n2);
  const _27b2 = Fp2.mul(Fp2.sqr(CURVE.b), BigInt(27));
  if (Fp2.is0(Fp2.add(_4a3, _27b2)))
    throw new Error("bad curve params: a or b");
  function isWithinCurveOrder(num) {
    return inRange(num, _1n4, CURVE.n);
  }
  function normPrivateKeyToScalar(key) {
    const { allowedPrivateKeyLengths: lengths, nByteLength, wrapPrivateKey, n: N } = CURVE;
    if (lengths && typeof key !== "bigint") {
      if (isBytes2(key))
        key = bytesToHex(key);
      if (typeof key !== "string" || !lengths.includes(key.length))
        throw new Error("invalid private key");
      key = key.padStart(nByteLength * 2, "0");
    }
    let num;
    try {
      num = typeof key === "bigint" ? key : bytesToNumberBE(ensureBytes("private key", key, nByteLength));
    } catch (error) {
      throw new Error("invalid private key, expected hex or " + nByteLength + " bytes, got " + typeof key);
    }
    if (wrapPrivateKey)
      num = mod(num, N);
    aInRange("private key", num, _1n4, N);
    return num;
  }
  function aprjpoint(other) {
    if (!(other instanceof Point))
      throw new Error("ProjectivePoint expected");
  }
  const toAffineMemo = memoized((p, iz) => {
    const { px: x, py: y, pz: z } = p;
    if (Fp2.eql(z, Fp2.ONE))
      return { x, y };
    const is0 = p.is0();
    if (iz == null)
      iz = is0 ? Fp2.ONE : Fp2.inv(z);
    const ax = Fp2.mul(x, iz);
    const ay = Fp2.mul(y, iz);
    const zz = Fp2.mul(z, iz);
    if (is0)
      return { x: Fp2.ZERO, y: Fp2.ZERO };
    if (!Fp2.eql(zz, Fp2.ONE))
      throw new Error("invZ was invalid");
    return { x: ax, y: ay };
  });
  const assertValidMemo = memoized((p) => {
    if (p.is0()) {
      if (CURVE.allowInfinityPoint && !Fp2.is0(p.py))
        return;
      throw new Error("bad point: ZERO");
    }
    const { x, y } = p.toAffine();
    if (!Fp2.isValid(x) || !Fp2.isValid(y))
      throw new Error("bad point: x or y not FE");
    if (!isValidXY(x, y))
      throw new Error("bad point: equation left != right");
    if (!p.isTorsionFree())
      throw new Error("bad point: not in prime-order subgroup");
    return true;
  });
  class Point {
    constructor(px, py, pz) {
      if (px == null || !Fp2.isValid(px))
        throw new Error("x required");
      if (py == null || !Fp2.isValid(py) || Fp2.is0(py))
        throw new Error("y required");
      if (pz == null || !Fp2.isValid(pz))
        throw new Error("z required");
      this.px = px;
      this.py = py;
      this.pz = pz;
      Object.freeze(this);
    }
    // Does not validate if the point is on-curve.
    // Use fromHex instead, or call assertValidity() later.
    static fromAffine(p) {
      const { x, y } = p || {};
      if (!p || !Fp2.isValid(x) || !Fp2.isValid(y))
        throw new Error("invalid affine point");
      if (p instanceof Point)
        throw new Error("projective point not allowed");
      const is0 = (i) => Fp2.eql(i, Fp2.ZERO);
      if (is0(x) && is0(y))
        return Point.ZERO;
      return new Point(x, y, Fp2.ONE);
    }
    get x() {
      return this.toAffine().x;
    }
    get y() {
      return this.toAffine().y;
    }
    /**
     * Takes a bunch of Projective Points but executes only one
     * inversion on all of them. Inversion is very slow operation,
     * so this improves performance massively.
     * Optimization: converts a list of projective points to a list of identical points with Z=1.
     */
    static normalizeZ(points) {
      const toInv = FpInvertBatch(Fp2, points.map((p) => p.pz));
      return points.map((p, i) => p.toAffine(toInv[i])).map(Point.fromAffine);
    }
    /**
     * Converts hash string or Uint8Array to Point.
     * @param hex short/long ECDSA hex
     */
    static fromHex(hex3) {
      const P = Point.fromAffine(fromBytes(ensureBytes("pointHex", hex3)));
      P.assertValidity();
      return P;
    }
    // Multiplies generator point by privateKey.
    static fromPrivateKey(privateKey) {
      return Point.BASE.multiply(normPrivateKeyToScalar(privateKey));
    }
    // Multiscalar Multiplication
    static msm(points, scalars) {
      return pippenger(Point, Fn, points, scalars);
    }
    // "Private method", don't use it directly
    _setWindowSize(windowSize) {
      wnaf.setWindowSize(this, windowSize);
    }
    // A point on curve is valid if it conforms to equation.
    assertValidity() {
      assertValidMemo(this);
    }
    hasEvenY() {
      const { y } = this.toAffine();
      if (Fp2.isOdd)
        return !Fp2.isOdd(y);
      throw new Error("Field doesn't support isOdd");
    }
    /**
     * Compare one point to another.
     */
    equals(other) {
      aprjpoint(other);
      const { px: X1, py: Y1, pz: Z1 } = this;
      const { px: X2, py: Y2, pz: Z2 } = other;
      const U1 = Fp2.eql(Fp2.mul(X1, Z2), Fp2.mul(X2, Z1));
      const U2 = Fp2.eql(Fp2.mul(Y1, Z2), Fp2.mul(Y2, Z1));
      return U1 && U2;
    }
    /**
     * Flips point to one corresponding to (x, -y) in Affine coordinates.
     */
    negate() {
      return new Point(this.px, Fp2.neg(this.py), this.pz);
    }
    // Renes-Costello-Batina exception-free doubling formula.
    // There is 30% faster Jacobian formula, but it is not complete.
    // https://eprint.iacr.org/2015/1060, algorithm 3
    // Cost: 8M + 3S + 3*a + 2*b3 + 15add.
    double() {
      const { a, b } = CURVE;
      const b3 = Fp2.mul(b, _3n2);
      const { px: X1, py: Y1, pz: Z1 } = this;
      let X3 = Fp2.ZERO, Y3 = Fp2.ZERO, Z3 = Fp2.ZERO;
      let t0 = Fp2.mul(X1, X1);
      let t1 = Fp2.mul(Y1, Y1);
      let t2 = Fp2.mul(Z1, Z1);
      let t3 = Fp2.mul(X1, Y1);
      t3 = Fp2.add(t3, t3);
      Z3 = Fp2.mul(X1, Z1);
      Z3 = Fp2.add(Z3, Z3);
      X3 = Fp2.mul(a, Z3);
      Y3 = Fp2.mul(b3, t2);
      Y3 = Fp2.add(X3, Y3);
      X3 = Fp2.sub(t1, Y3);
      Y3 = Fp2.add(t1, Y3);
      Y3 = Fp2.mul(X3, Y3);
      X3 = Fp2.mul(t3, X3);
      Z3 = Fp2.mul(b3, Z3);
      t2 = Fp2.mul(a, t2);
      t3 = Fp2.sub(t0, t2);
      t3 = Fp2.mul(a, t3);
      t3 = Fp2.add(t3, Z3);
      Z3 = Fp2.add(t0, t0);
      t0 = Fp2.add(Z3, t0);
      t0 = Fp2.add(t0, t2);
      t0 = Fp2.mul(t0, t3);
      Y3 = Fp2.add(Y3, t0);
      t2 = Fp2.mul(Y1, Z1);
      t2 = Fp2.add(t2, t2);
      t0 = Fp2.mul(t2, t3);
      X3 = Fp2.sub(X3, t0);
      Z3 = Fp2.mul(t2, t1);
      Z3 = Fp2.add(Z3, Z3);
      Z3 = Fp2.add(Z3, Z3);
      return new Point(X3, Y3, Z3);
    }
    // Renes-Costello-Batina exception-free addition formula.
    // There is 30% faster Jacobian formula, but it is not complete.
    // https://eprint.iacr.org/2015/1060, algorithm 1
    // Cost: 12M + 0S + 3*a + 3*b3 + 23add.
    add(other) {
      aprjpoint(other);
      const { px: X1, py: Y1, pz: Z1 } = this;
      const { px: X2, py: Y2, pz: Z2 } = other;
      let X3 = Fp2.ZERO, Y3 = Fp2.ZERO, Z3 = Fp2.ZERO;
      const a = CURVE.a;
      const b3 = Fp2.mul(CURVE.b, _3n2);
      let t0 = Fp2.mul(X1, X2);
      let t1 = Fp2.mul(Y1, Y2);
      let t2 = Fp2.mul(Z1, Z2);
      let t3 = Fp2.add(X1, Y1);
      let t4 = Fp2.add(X2, Y2);
      t3 = Fp2.mul(t3, t4);
      t4 = Fp2.add(t0, t1);
      t3 = Fp2.sub(t3, t4);
      t4 = Fp2.add(X1, Z1);
      let t5 = Fp2.add(X2, Z2);
      t4 = Fp2.mul(t4, t5);
      t5 = Fp2.add(t0, t2);
      t4 = Fp2.sub(t4, t5);
      t5 = Fp2.add(Y1, Z1);
      X3 = Fp2.add(Y2, Z2);
      t5 = Fp2.mul(t5, X3);
      X3 = Fp2.add(t1, t2);
      t5 = Fp2.sub(t5, X3);
      Z3 = Fp2.mul(a, t4);
      X3 = Fp2.mul(b3, t2);
      Z3 = Fp2.add(X3, Z3);
      X3 = Fp2.sub(t1, Z3);
      Z3 = Fp2.add(t1, Z3);
      Y3 = Fp2.mul(X3, Z3);
      t1 = Fp2.add(t0, t0);
      t1 = Fp2.add(t1, t0);
      t2 = Fp2.mul(a, t2);
      t4 = Fp2.mul(b3, t4);
      t1 = Fp2.add(t1, t2);
      t2 = Fp2.sub(t0, t2);
      t2 = Fp2.mul(a, t2);
      t4 = Fp2.add(t4, t2);
      t0 = Fp2.mul(t1, t4);
      Y3 = Fp2.add(Y3, t0);
      t0 = Fp2.mul(t5, t4);
      X3 = Fp2.mul(t3, X3);
      X3 = Fp2.sub(X3, t0);
      t0 = Fp2.mul(t3, t1);
      Z3 = Fp2.mul(t5, Z3);
      Z3 = Fp2.add(Z3, t0);
      return new Point(X3, Y3, Z3);
    }
    subtract(other) {
      return this.add(other.negate());
    }
    is0() {
      return this.equals(Point.ZERO);
    }
    wNAF(n) {
      return wnaf.wNAFCached(this, n, Point.normalizeZ);
    }
    /**
     * Non-constant-time multiplication. Uses double-and-add algorithm.
     * It's faster, but should only be used when you don't care about
     * an exposed private key e.g. sig verification, which works over *public* keys.
     */
    multiplyUnsafe(sc) {
      const { endo: endo2, n: N } = CURVE;
      aInRange("scalar", sc, _0n4, N);
      const I = Point.ZERO;
      if (sc === _0n4)
        return I;
      if (this.is0() || sc === _1n4)
        return this;
      if (!endo2 || wnaf.hasPrecomputes(this))
        return wnaf.wNAFCachedUnsafe(this, sc, Point.normalizeZ);
      let { k1neg, k1, k2neg, k2 } = endo2.splitScalar(sc);
      let k1p = I;
      let k2p = I;
      let d = this;
      while (k1 > _0n4 || k2 > _0n4) {
        if (k1 & _1n4)
          k1p = k1p.add(d);
        if (k2 & _1n4)
          k2p = k2p.add(d);
        d = d.double();
        k1 >>= _1n4;
        k2 >>= _1n4;
      }
      if (k1neg)
        k1p = k1p.negate();
      if (k2neg)
        k2p = k2p.negate();
      k2p = new Point(Fp2.mul(k2p.px, endo2.beta), k2p.py, k2p.pz);
      return k1p.add(k2p);
    }
    /**
     * Constant time multiplication.
     * Uses wNAF method. Windowed method may be 10% faster,
     * but takes 2x longer to generate and consumes 2x memory.
     * Uses precomputes when available.
     * Uses endomorphism for Koblitz curves.
     * @param scalar by which the point would be multiplied
     * @returns New point
     */
    multiply(scalar) {
      const { endo: endo2, n: N } = CURVE;
      aInRange("scalar", scalar, _1n4, N);
      let point, fake;
      if (endo2) {
        const { k1neg, k1, k2neg, k2 } = endo2.splitScalar(scalar);
        let { p: k1p, f: f1p } = this.wNAF(k1);
        let { p: k2p, f: f2p } = this.wNAF(k2);
        k1p = wnaf.constTimeNegate(k1neg, k1p);
        k2p = wnaf.constTimeNegate(k2neg, k2p);
        k2p = new Point(Fp2.mul(k2p.px, endo2.beta), k2p.py, k2p.pz);
        point = k1p.add(k2p);
        fake = f1p.add(f2p);
      } else {
        const { p, f } = this.wNAF(scalar);
        point = p;
        fake = f;
      }
      return Point.normalizeZ([point, fake])[0];
    }
    /**
     * Efficiently calculate `aP + bQ`. Unsafe, can expose private key, if used incorrectly.
     * Not using Strauss-Shamir trick: precomputation tables are faster.
     * The trick could be useful if both P and Q are not G (not in our case).
     * @returns non-zero affine point
     */
    multiplyAndAddUnsafe(Q, a, b) {
      const G = Point.BASE;
      const mul = (P, a2) => a2 === _0n4 || a2 === _1n4 || !P.equals(G) ? P.multiplyUnsafe(a2) : P.multiply(a2);
      const sum = mul(this, a).add(mul(Q, b));
      return sum.is0() ? void 0 : sum;
    }
    // Converts Projective point to affine (x, y) coordinates.
    // Can accept precomputed Z^-1 - for example, from invertBatch.
    // (x, y, z) ∋ (x=x/z, y=y/z)
    toAffine(iz) {
      return toAffineMemo(this, iz);
    }
    isTorsionFree() {
      const { h: cofactor, isTorsionFree } = CURVE;
      if (cofactor === _1n4)
        return true;
      if (isTorsionFree)
        return isTorsionFree(Point, this);
      throw new Error("isTorsionFree() has not been declared for the elliptic curve");
    }
    clearCofactor() {
      const { h: cofactor, clearCofactor } = CURVE;
      if (cofactor === _1n4)
        return this;
      if (clearCofactor)
        return clearCofactor(Point, this);
      return this.multiplyUnsafe(CURVE.h);
    }
    toRawBytes(isCompressed = true) {
      abool("isCompressed", isCompressed);
      this.assertValidity();
      return toBytes2(Point, this, isCompressed);
    }
    toHex(isCompressed = true) {
      abool("isCompressed", isCompressed);
      return bytesToHex(this.toRawBytes(isCompressed));
    }
  }
  Point.BASE = new Point(CURVE.Gx, CURVE.Gy, Fp2.ONE);
  Point.ZERO = new Point(Fp2.ZERO, Fp2.ONE, Fp2.ZERO);
  const { endo, nBitLength } = CURVE;
  const wnaf = wNAF(Point, endo ? Math.ceil(nBitLength / 2) : nBitLength);
  return {
    CURVE,
    ProjectivePoint: Point,
    normPrivateKeyToScalar,
    weierstrassEquation,
    isWithinCurveOrder
  };
}
function validateOpts(curve) {
  const opts = validateBasic(curve);
  validateObject(opts, {
    hash: "hash",
    hmac: "function",
    randomBytes: "function"
  }, {
    bits2int: "function",
    bits2int_modN: "function",
    lowS: "boolean"
  });
  return Object.freeze({ lowS: true, ...opts });
}
function weierstrass(curveDef) {
  const CURVE = validateOpts(curveDef);
  const { Fp: Fp2, n: CURVE_ORDER, nByteLength, nBitLength } = CURVE;
  const compressedLen = Fp2.BYTES + 1;
  const uncompressedLen = 2 * Fp2.BYTES + 1;
  function modN(a) {
    return mod(a, CURVE_ORDER);
  }
  function invN(a) {
    return invert(a, CURVE_ORDER);
  }
  const { ProjectivePoint: Point, normPrivateKeyToScalar, weierstrassEquation, isWithinCurveOrder } = weierstrassPoints({
    ...CURVE,
    toBytes(_c, point, isCompressed) {
      const a = point.toAffine();
      const x = Fp2.toBytes(a.x);
      const cat = concatBytes2;
      abool("isCompressed", isCompressed);
      if (isCompressed) {
        return cat(Uint8Array.from([point.hasEvenY() ? 2 : 3]), x);
      } else {
        return cat(Uint8Array.from([4]), x, Fp2.toBytes(a.y));
      }
    },
    fromBytes(bytes2) {
      const len = bytes2.length;
      const head = bytes2[0];
      const tail = bytes2.subarray(1);
      if (len === compressedLen && (head === 2 || head === 3)) {
        const x = bytesToNumberBE(tail);
        if (!inRange(x, _1n4, Fp2.ORDER))
          throw new Error("Point is not on curve");
        const y2 = weierstrassEquation(x);
        let y;
        try {
          y = Fp2.sqrt(y2);
        } catch (sqrtError) {
          const suffix = sqrtError instanceof Error ? ": " + sqrtError.message : "";
          throw new Error("Point is not on curve" + suffix);
        }
        const isYOdd = (y & _1n4) === _1n4;
        const isHeadOdd = (head & 1) === 1;
        if (isHeadOdd !== isYOdd)
          y = Fp2.neg(y);
        return { x, y };
      } else if (len === uncompressedLen && head === 4) {
        const x = Fp2.fromBytes(tail.subarray(0, Fp2.BYTES));
        const y = Fp2.fromBytes(tail.subarray(Fp2.BYTES, 2 * Fp2.BYTES));
        return { x, y };
      } else {
        const cl = compressedLen;
        const ul = uncompressedLen;
        throw new Error("invalid Point, expected length of " + cl + ", or uncompressed " + ul + ", got " + len);
      }
    }
  });
  function isBiggerThanHalfOrder(number) {
    const HALF = CURVE_ORDER >> _1n4;
    return number > HALF;
  }
  function normalizeS(s) {
    return isBiggerThanHalfOrder(s) ? modN(-s) : s;
  }
  const slcNum = (b, from, to) => bytesToNumberBE(b.slice(from, to));
  class Signature {
    constructor(r, s, recovery) {
      aInRange("r", r, _1n4, CURVE_ORDER);
      aInRange("s", s, _1n4, CURVE_ORDER);
      this.r = r;
      this.s = s;
      if (recovery != null)
        this.recovery = recovery;
      Object.freeze(this);
    }
    // pair (bytes of r, bytes of s)
    static fromCompact(hex3) {
      const l = nByteLength;
      hex3 = ensureBytes("compactSignature", hex3, l * 2);
      return new Signature(slcNum(hex3, 0, l), slcNum(hex3, l, 2 * l));
    }
    // DER encoded ECDSA signature
    // https://bitcoin.stackexchange.com/questions/57644/what-are-the-parts-of-a-bitcoin-transaction-input-script
    static fromDER(hex3) {
      const { r, s } = DER.toSig(ensureBytes("DER", hex3));
      return new Signature(r, s);
    }
    /**
     * @todo remove
     * @deprecated
     */
    assertValidity() {
    }
    addRecoveryBit(recovery) {
      return new Signature(this.r, this.s, recovery);
    }
    recoverPublicKey(msgHash) {
      const { r, s, recovery: rec } = this;
      const h = bits2int_modN(ensureBytes("msgHash", msgHash));
      if (rec == null || ![0, 1, 2, 3].includes(rec))
        throw new Error("recovery id invalid");
      const radj = rec === 2 || rec === 3 ? r + CURVE.n : r;
      if (radj >= Fp2.ORDER)
        throw new Error("recovery id 2 or 3 invalid");
      const prefix = (rec & 1) === 0 ? "02" : "03";
      const R = Point.fromHex(prefix + numToSizedHex(radj, Fp2.BYTES));
      const ir = invN(radj);
      const u1 = modN(-h * ir);
      const u2 = modN(s * ir);
      const Q = Point.BASE.multiplyAndAddUnsafe(R, u1, u2);
      if (!Q)
        throw new Error("point at infinify");
      Q.assertValidity();
      return Q;
    }
    // Signatures should be low-s, to prevent malleability.
    hasHighS() {
      return isBiggerThanHalfOrder(this.s);
    }
    normalizeS() {
      return this.hasHighS() ? new Signature(this.r, modN(-this.s), this.recovery) : this;
    }
    // DER-encoded
    toDERRawBytes() {
      return hexToBytes(this.toDERHex());
    }
    toDERHex() {
      return DER.hexFromSig(this);
    }
    // padded bytes of r, then padded bytes of s
    toCompactRawBytes() {
      return hexToBytes(this.toCompactHex());
    }
    toCompactHex() {
      const l = nByteLength;
      return numToSizedHex(this.r, l) + numToSizedHex(this.s, l);
    }
  }
  const utils = {
    isValidPrivateKey(privateKey) {
      try {
        normPrivateKeyToScalar(privateKey);
        return true;
      } catch (error) {
        return false;
      }
    },
    normPrivateKeyToScalar,
    /**
     * Produces cryptographically secure private key from random of size
     * (groupLen + ceil(groupLen / 2)) with modulo bias being negligible.
     */
    randomPrivateKey: () => {
      const length = getMinHashLength(CURVE.n);
      return mapHashToField(CURVE.randomBytes(length), CURVE.n);
    },
    /**
     * Creates precompute table for an arbitrary EC point. Makes point "cached".
     * Allows to massively speed-up `point.multiply(scalar)`.
     * @returns cached point
     * @example
     * const fast = utils.precompute(8, ProjectivePoint.fromHex(someonesPubKey));
     * fast.multiply(privKey); // much faster ECDH now
     */
    precompute(windowSize = 8, point = Point.BASE) {
      point._setWindowSize(windowSize);
      point.multiply(BigInt(3));
      return point;
    }
  };
  function getPublicKey(privateKey, isCompressed = true) {
    return Point.fromPrivateKey(privateKey).toRawBytes(isCompressed);
  }
  function isProbPub(item) {
    if (typeof item === "bigint")
      return false;
    if (item instanceof Point)
      return true;
    const arr = ensureBytes("key", item);
    const len = arr.length;
    const fpl = Fp2.BYTES;
    const compLen = fpl + 1;
    const uncompLen = 2 * fpl + 1;
    if (CURVE.allowedPrivateKeyLengths || nByteLength === compLen) {
      return void 0;
    } else {
      return len === compLen || len === uncompLen;
    }
  }
  function getSharedSecret(privateA, publicB, isCompressed = true) {
    if (isProbPub(privateA) === true)
      throw new Error("first arg must be private key");
    if (isProbPub(publicB) === false)
      throw new Error("second arg must be public key");
    const b = Point.fromHex(publicB);
    return b.multiply(normPrivateKeyToScalar(privateA)).toRawBytes(isCompressed);
  }
  const bits2int = CURVE.bits2int || function(bytes2) {
    if (bytes2.length > 8192)
      throw new Error("input is too large");
    const num = bytesToNumberBE(bytes2);
    const delta = bytes2.length * 8 - nBitLength;
    return delta > 0 ? num >> BigInt(delta) : num;
  };
  const bits2int_modN = CURVE.bits2int_modN || function(bytes2) {
    return modN(bits2int(bytes2));
  };
  const ORDER_MASK = bitMask(nBitLength);
  function int2octets(num) {
    aInRange("num < 2^" + nBitLength, num, _0n4, ORDER_MASK);
    return numberToBytesBE(num, nByteLength);
  }
  function prepSig(msgHash, privateKey, opts = defaultSigOpts) {
    if (["recovered", "canonical"].some((k) => k in opts))
      throw new Error("sign() legacy options not supported");
    const { hash, randomBytes: randomBytes2 } = CURVE;
    let { lowS, prehash, extraEntropy: ent } = opts;
    if (lowS == null)
      lowS = true;
    msgHash = ensureBytes("msgHash", msgHash);
    validateSigVerOpts(opts);
    if (prehash)
      msgHash = ensureBytes("prehashed msgHash", hash(msgHash));
    const h1int = bits2int_modN(msgHash);
    const d = normPrivateKeyToScalar(privateKey);
    const seedArgs = [int2octets(d), int2octets(h1int)];
    if (ent != null && ent !== false) {
      const e = ent === true ? randomBytes2(Fp2.BYTES) : ent;
      seedArgs.push(ensureBytes("extraEntropy", e));
    }
    const seed = concatBytes2(...seedArgs);
    const m = h1int;
    function k2sig(kBytes) {
      const k = bits2int(kBytes);
      if (!isWithinCurveOrder(k))
        return;
      const ik = invN(k);
      const q = Point.BASE.multiply(k).toAffine();
      const r = modN(q.x);
      if (r === _0n4)
        return;
      const s = modN(ik * modN(m + r * d));
      if (s === _0n4)
        return;
      let recovery = (q.x === r ? 0 : 2) | Number(q.y & _1n4);
      let normS = s;
      if (lowS && isBiggerThanHalfOrder(s)) {
        normS = normalizeS(s);
        recovery ^= 1;
      }
      return new Signature(r, normS, recovery);
    }
    return { seed, k2sig };
  }
  const defaultSigOpts = { lowS: CURVE.lowS, prehash: false };
  const defaultVerOpts = { lowS: CURVE.lowS, prehash: false };
  function sign(msgHash, privKey, opts = defaultSigOpts) {
    const { seed, k2sig } = prepSig(msgHash, privKey, opts);
    const C = CURVE;
    const drbg = createHmacDrbg(C.hash.outputLen, C.nByteLength, C.hmac);
    return drbg(seed, k2sig);
  }
  Point.BASE._setWindowSize(8);
  function verify(signature, msgHash, publicKey, opts = defaultVerOpts) {
    const sg = signature;
    msgHash = ensureBytes("msgHash", msgHash);
    publicKey = ensureBytes("publicKey", publicKey);
    const { lowS, prehash, format } = opts;
    validateSigVerOpts(opts);
    if ("strict" in opts)
      throw new Error("options.strict was renamed to lowS");
    if (format !== void 0 && format !== "compact" && format !== "der")
      throw new Error("format must be compact or der");
    const isHex = typeof sg === "string" || isBytes2(sg);
    const isObj = !isHex && !format && typeof sg === "object" && sg !== null && typeof sg.r === "bigint" && typeof sg.s === "bigint";
    if (!isHex && !isObj)
      throw new Error("invalid signature, expected Uint8Array, hex string or Signature instance");
    let _sig = void 0;
    let P;
    try {
      if (isObj)
        _sig = new Signature(sg.r, sg.s);
      if (isHex) {
        try {
          if (format !== "compact")
            _sig = Signature.fromDER(sg);
        } catch (derError) {
          if (!(derError instanceof DER.Err))
            throw derError;
        }
        if (!_sig && format !== "der")
          _sig = Signature.fromCompact(sg);
      }
      P = Point.fromHex(publicKey);
    } catch (error) {
      return false;
    }
    if (!_sig)
      return false;
    if (lowS && _sig.hasHighS())
      return false;
    if (prehash)
      msgHash = CURVE.hash(msgHash);
    const { r, s } = _sig;
    const h = bits2int_modN(msgHash);
    const is = invN(s);
    const u1 = modN(h * is);
    const u2 = modN(r * is);
    const R = Point.BASE.multiplyAndAddUnsafe(P, u1, u2)?.toAffine();
    if (!R)
      return false;
    const v = modN(R.x);
    return v === r;
  }
  return {
    CURVE,
    getPublicKey,
    getSharedSecret,
    sign,
    verify,
    ProjectivePoint: Point,
    Signature,
    utils
  };
}
var DERErr, DER, _0n4, _1n4, _2n2, _3n2, _4n2;
var init_weierstrass = __esm({
  "node_modules/@noble/curves/esm/abstract/weierstrass.js"() {
    init_curve();
    init_modular();
    init_utils2();
    DERErr = class extends Error {
      constructor(m = "") {
        super(m);
      }
    };
    DER = {
      // asn.1 DER encoding utils
      Err: DERErr,
      // Basic building block is TLV (Tag-Length-Value)
      _tlv: {
        encode: (tag, data) => {
          const { Err: E } = DER;
          if (tag < 0 || tag > 256)
            throw new E("tlv.encode: wrong tag");
          if (data.length & 1)
            throw new E("tlv.encode: unpadded data");
          const dataLen = data.length / 2;
          const len = numberToHexUnpadded(dataLen);
          if (len.length / 2 & 128)
            throw new E("tlv.encode: long form length too big");
          const lenLen = dataLen > 127 ? numberToHexUnpadded(len.length / 2 | 128) : "";
          const t = numberToHexUnpadded(tag);
          return t + lenLen + len + data;
        },
        // v - value, l - left bytes (unparsed)
        decode(tag, data) {
          const { Err: E } = DER;
          let pos = 0;
          if (tag < 0 || tag > 256)
            throw new E("tlv.encode: wrong tag");
          if (data.length < 2 || data[pos++] !== tag)
            throw new E("tlv.decode: wrong tlv");
          const first = data[pos++];
          const isLong = !!(first & 128);
          let length = 0;
          if (!isLong)
            length = first;
          else {
            const lenLen = first & 127;
            if (!lenLen)
              throw new E("tlv.decode(long): indefinite length not supported");
            if (lenLen > 4)
              throw new E("tlv.decode(long): byte length is too big");
            const lengthBytes2 = data.subarray(pos, pos + lenLen);
            if (lengthBytes2.length !== lenLen)
              throw new E("tlv.decode: length bytes not complete");
            if (lengthBytes2[0] === 0)
              throw new E("tlv.decode(long): zero leftmost byte");
            for (const b of lengthBytes2)
              length = length << 8 | b;
            pos += lenLen;
            if (length < 128)
              throw new E("tlv.decode(long): not minimal encoding");
          }
          const v = data.subarray(pos, pos + length);
          if (v.length !== length)
            throw new E("tlv.decode: wrong value length");
          return { v, l: data.subarray(pos + length) };
        }
      },
      // https://crypto.stackexchange.com/a/57734 Leftmost bit of first byte is 'negative' flag,
      // since we always use positive integers here. It must always be empty:
      // - add zero byte if exists
      // - if next byte doesn't have a flag, leading zero is not allowed (minimal encoding)
      _int: {
        encode(num) {
          const { Err: E } = DER;
          if (num < _0n4)
            throw new E("integer: negative integers are not allowed");
          let hex3 = numberToHexUnpadded(num);
          if (Number.parseInt(hex3[0], 16) & 8)
            hex3 = "00" + hex3;
          if (hex3.length & 1)
            throw new E("unexpected DER parsing assertion: unpadded hex");
          return hex3;
        },
        decode(data) {
          const { Err: E } = DER;
          if (data[0] & 128)
            throw new E("invalid signature integer: negative");
          if (data[0] === 0 && !(data[1] & 128))
            throw new E("invalid signature integer: unnecessary leading zero");
          return bytesToNumberBE(data);
        }
      },
      toSig(hex3) {
        const { Err: E, _int: int, _tlv: tlv2 } = DER;
        const data = ensureBytes("signature", hex3);
        const { v: seqBytes, l: seqLeftBytes } = tlv2.decode(48, data);
        if (seqLeftBytes.length)
          throw new E("invalid signature: left bytes after parsing");
        const { v: rBytes, l: rLeftBytes } = tlv2.decode(2, seqBytes);
        const { v: sBytes, l: sLeftBytes } = tlv2.decode(2, rLeftBytes);
        if (sLeftBytes.length)
          throw new E("invalid signature: left bytes after parsing");
        return { r: int.decode(rBytes), s: int.decode(sBytes) };
      },
      hexFromSig(sig) {
        const { _tlv: tlv2, _int: int } = DER;
        const rs = tlv2.encode(2, int.encode(sig.r));
        const ss = tlv2.encode(2, int.encode(sig.s));
        const seq = rs + ss;
        return tlv2.encode(48, seq);
      }
    };
    _0n4 = BigInt(0);
    _1n4 = BigInt(1);
    _2n2 = BigInt(2);
    _3n2 = BigInt(3);
    _4n2 = BigInt(4);
  }
});

// node_modules/@noble/curves/esm/_shortw_utils.js
function getHash(hash) {
  return {
    hash,
    hmac: (key, ...msgs) => hmac(hash, key, concatBytes(...msgs)),
    randomBytes
  };
}
function createCurve(curveDef, defHash) {
  const create = (hash) => weierstrass({ ...curveDef, ...getHash(hash) });
  return { ...create(defHash), create };
}
var init_shortw_utils = __esm({
  "node_modules/@noble/curves/esm/_shortw_utils.js"() {
    init_hmac();
    init_utils();
    init_weierstrass();
  }
});

// node_modules/@noble/curves/esm/nist.js
var Fp256, p256_a, p256_b, p256, Fp384, p384_a, p384_b, p384, Fp521, p521_a, p521_b, p521;
var init_nist = __esm({
  "node_modules/@noble/curves/esm/nist.js"() {
    init_sha2();
    init_shortw_utils();
    init_modular();
    Fp256 = Field(BigInt("0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff"));
    p256_a = Fp256.create(BigInt("-3"));
    p256_b = BigInt("0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b");
    p256 = createCurve({
      a: p256_a,
      b: p256_b,
      Fp: Fp256,
      n: BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551"),
      Gx: BigInt("0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296"),
      Gy: BigInt("0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5"),
      h: BigInt(1),
      lowS: false
    }, sha2563);
    Fp384 = Field(BigInt("0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffeffffffff0000000000000000ffffffff"));
    p384_a = Fp384.create(BigInt("-3"));
    p384_b = BigInt("0xb3312fa7e23ee7e4988e056be3f82d19181d9c6efe8141120314088f5013875ac656398d8a2ed19d2a85c8edd3ec2aef");
    p384 = createCurve({
      a: p384_a,
      b: p384_b,
      Fp: Fp384,
      n: BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffc7634d81f4372ddf581a0db248b0a77aecec196accc52973"),
      Gx: BigInt("0xaa87ca22be8b05378eb1c71ef320ad746e1d3b628ba79b9859f741e082542a385502f25dbf55296c3a545e3872760ab7"),
      Gy: BigInt("0x3617de4a96262c6f5d9e98bf9292dc29f8f41dbd289a147ce9da3113b5f0b8c00a60b1ce1d7e819d7a431d7c90ea0e5f"),
      h: BigInt(1),
      lowS: false
    }, sha384);
    Fp521 = Field(BigInt("0x1ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"));
    p521_a = Fp521.create(BigInt("-3"));
    p521_b = BigInt("0x0051953eb9618e1c9a1f929a21a0b68540eea2da725b99b315f3b8b489918ef109e156193951ec7e937b1652c0bd3bb1bf073573df883d2c34f1ef451fd46b503f00");
    p521 = createCurve({
      a: p521_a,
      b: p521_b,
      Fp: Fp521,
      n: BigInt("0x01fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffa51868783bf2f966b7fcc0148f709a5d03bb5c9b8899c47aebb6fb71e91386409"),
      Gx: BigInt("0x00c6858e06b70404e9cd9e3ecb662395b4429c648139053fb521f828af606b4d3dbaa14b5e77efe75928fe1dc127a2ffa8de3348b3c1856a429bf97e7e31c2e5bd66"),
      Gy: BigInt("0x011839296a789a3bc0045c8a5fb42c7d1bd998f54449579b446817afbd17273e662c97ee72995ef42640c550b9013fad0761353c7086a272c24088be94769fd16650"),
      h: BigInt(1),
      lowS: false,
      allowedPrivateKeyLengths: [130, 131, 132]
      // P521 keys are variable-length. Normalize to 132b
    }, sha512);
  }
});

// node_modules/@noble/curves/esm/abstract/edwards.js
function validateOpts2(curve) {
  const opts = validateBasic(curve);
  validateObject(curve, {
    hash: "function",
    a: "bigint",
    d: "bigint",
    randomBytes: "function"
  }, {
    adjustScalarBytes: "function",
    domain: "function",
    uvRatio: "function",
    mapToCurve: "function"
  });
  return Object.freeze({ ...opts });
}
function twistedEdwards(curveDef) {
  const CURVE = validateOpts2(curveDef);
  const { Fp: Fp2, n: CURVE_ORDER, prehash, hash: cHash, randomBytes: randomBytes2, nByteLength, h: cofactor } = CURVE;
  const MASK = _2n3 << BigInt(nByteLength * 8) - _1n5;
  const modP = Fp2.create;
  const Fn = Field(CURVE.n, CURVE.nBitLength);
  function isEdValidXY(x, y) {
    const x2 = Fp2.sqr(x);
    const y2 = Fp2.sqr(y);
    const left = Fp2.add(Fp2.mul(CURVE.a, x2), y2);
    const right = Fp2.add(Fp2.ONE, Fp2.mul(CURVE.d, Fp2.mul(x2, y2)));
    return Fp2.eql(left, right);
  }
  if (!isEdValidXY(CURVE.Gx, CURVE.Gy))
    throw new Error("bad curve params: generator point");
  const uvRatio2 = CURVE.uvRatio || ((u, v) => {
    try {
      return { isValid: true, value: Fp2.sqrt(u * Fp2.inv(v)) };
    } catch (e) {
      return { isValid: false, value: _0n5 };
    }
  });
  const adjustScalarBytes2 = CURVE.adjustScalarBytes || ((bytes2) => bytes2);
  const domain = CURVE.domain || ((data, ctx, phflag) => {
    abool("phflag", phflag);
    if (ctx.length || phflag)
      throw new Error("Contexts/pre-hash are not supported");
    return data;
  });
  function aCoordinate(title, n, banZero = false) {
    const min = banZero ? _1n5 : _0n5;
    aInRange("coordinate " + title, n, min, MASK);
  }
  function aextpoint(other) {
    if (!(other instanceof Point))
      throw new Error("ExtendedPoint expected");
  }
  const toAffineMemo = memoized((p, iz) => {
    const { ex: x, ey: y, ez: z } = p;
    const is0 = p.is0();
    if (iz == null)
      iz = is0 ? _8n2 : Fp2.inv(z);
    const ax = modP(x * iz);
    const ay = modP(y * iz);
    const zz = modP(z * iz);
    if (is0)
      return { x: _0n5, y: _1n5 };
    if (zz !== _1n5)
      throw new Error("invZ was invalid");
    return { x: ax, y: ay };
  });
  const assertValidMemo = memoized((p) => {
    const { a, d } = CURVE;
    if (p.is0())
      throw new Error("bad point: ZERO");
    const { ex: X, ey: Y, ez: Z, et: T } = p;
    const X2 = modP(X * X);
    const Y2 = modP(Y * Y);
    const Z2 = modP(Z * Z);
    const Z4 = modP(Z2 * Z2);
    const aX2 = modP(X2 * a);
    const left = modP(Z2 * modP(aX2 + Y2));
    const right = modP(Z4 + modP(d * modP(X2 * Y2)));
    if (left !== right)
      throw new Error("bad point: equation left != right (1)");
    const XY = modP(X * Y);
    const ZT = modP(Z * T);
    if (XY !== ZT)
      throw new Error("bad point: equation left != right (2)");
    return true;
  });
  class Point {
    constructor(ex, ey, ez, et) {
      aCoordinate("x", ex);
      aCoordinate("y", ey);
      aCoordinate("z", ez, true);
      aCoordinate("t", et);
      this.ex = ex;
      this.ey = ey;
      this.ez = ez;
      this.et = et;
      Object.freeze(this);
    }
    get x() {
      return this.toAffine().x;
    }
    get y() {
      return this.toAffine().y;
    }
    static fromAffine(p) {
      if (p instanceof Point)
        throw new Error("extended point not allowed");
      const { x, y } = p || {};
      aCoordinate("x", x);
      aCoordinate("y", y);
      return new Point(x, y, _1n5, modP(x * y));
    }
    static normalizeZ(points) {
      const toInv = FpInvertBatch(Fp2, points.map((p) => p.ez));
      return points.map((p, i) => p.toAffine(toInv[i])).map(Point.fromAffine);
    }
    // Multiscalar Multiplication
    static msm(points, scalars) {
      return pippenger(Point, Fn, points, scalars);
    }
    // "Private method", don't use it directly
    _setWindowSize(windowSize) {
      wnaf.setWindowSize(this, windowSize);
    }
    // Not required for fromHex(), which always creates valid points.
    // Could be useful for fromAffine().
    assertValidity() {
      assertValidMemo(this);
    }
    // Compare one point to another.
    equals(other) {
      aextpoint(other);
      const { ex: X1, ey: Y1, ez: Z1 } = this;
      const { ex: X2, ey: Y2, ez: Z2 } = other;
      const X1Z2 = modP(X1 * Z2);
      const X2Z1 = modP(X2 * Z1);
      const Y1Z2 = modP(Y1 * Z2);
      const Y2Z1 = modP(Y2 * Z1);
      return X1Z2 === X2Z1 && Y1Z2 === Y2Z1;
    }
    is0() {
      return this.equals(Point.ZERO);
    }
    negate() {
      return new Point(modP(-this.ex), this.ey, this.ez, modP(-this.et));
    }
    // Fast algo for doubling Extended Point.
    // https://hyperelliptic.org/EFD/g1p/auto-twisted-extended.html#doubling-dbl-2008-hwcd
    // Cost: 4M + 4S + 1*a + 6add + 1*2.
    double() {
      const { a } = CURVE;
      const { ex: X1, ey: Y1, ez: Z1 } = this;
      const A = modP(X1 * X1);
      const B = modP(Y1 * Y1);
      const C = modP(_2n3 * modP(Z1 * Z1));
      const D = modP(a * A);
      const x1y1 = X1 + Y1;
      const E = modP(modP(x1y1 * x1y1) - A - B);
      const G2 = D + B;
      const F = G2 - C;
      const H = D - B;
      const X3 = modP(E * F);
      const Y3 = modP(G2 * H);
      const T3 = modP(E * H);
      const Z3 = modP(F * G2);
      return new Point(X3, Y3, Z3, T3);
    }
    // Fast algo for adding 2 Extended Points.
    // https://hyperelliptic.org/EFD/g1p/auto-twisted-extended.html#addition-add-2008-hwcd
    // Cost: 9M + 1*a + 1*d + 7add.
    add(other) {
      aextpoint(other);
      const { a, d } = CURVE;
      const { ex: X1, ey: Y1, ez: Z1, et: T1 } = this;
      const { ex: X2, ey: Y2, ez: Z2, et: T2 } = other;
      const A = modP(X1 * X2);
      const B = modP(Y1 * Y2);
      const C = modP(T1 * d * T2);
      const D = modP(Z1 * Z2);
      const E = modP((X1 + Y1) * (X2 + Y2) - A - B);
      const F = D - C;
      const G2 = D + C;
      const H = modP(B - a * A);
      const X3 = modP(E * F);
      const Y3 = modP(G2 * H);
      const T3 = modP(E * H);
      const Z3 = modP(F * G2);
      return new Point(X3, Y3, Z3, T3);
    }
    subtract(other) {
      return this.add(other.negate());
    }
    wNAF(n) {
      return wnaf.wNAFCached(this, n, Point.normalizeZ);
    }
    // Constant-time multiplication.
    multiply(scalar) {
      const n = scalar;
      aInRange("scalar", n, _1n5, CURVE_ORDER);
      const { p, f } = this.wNAF(n);
      return Point.normalizeZ([p, f])[0];
    }
    // Non-constant-time multiplication. Uses double-and-add algorithm.
    // It's faster, but should only be used when you don't care about
    // an exposed private key e.g. sig verification.
    // Does NOT allow scalars higher than CURVE.n.
    // Accepts optional accumulator to merge with multiply (important for sparse scalars)
    multiplyUnsafe(scalar, acc = Point.ZERO) {
      const n = scalar;
      aInRange("scalar", n, _0n5, CURVE_ORDER);
      if (n === _0n5)
        return I;
      if (this.is0() || n === _1n5)
        return this;
      return wnaf.wNAFCachedUnsafe(this, n, Point.normalizeZ, acc);
    }
    // Checks if point is of small order.
    // If you add something to small order point, you will have "dirty"
    // point with torsion component.
    // Multiplies point by cofactor and checks if the result is 0.
    isSmallOrder() {
      return this.multiplyUnsafe(cofactor).is0();
    }
    // Multiplies point by curve order and checks if the result is 0.
    // Returns `false` is the point is dirty.
    isTorsionFree() {
      return wnaf.unsafeLadder(this, CURVE_ORDER).is0();
    }
    // Converts Extended point to default (x, y) coordinates.
    // Can accept precomputed Z^-1 - for example, from invertBatch.
    toAffine(iz) {
      return toAffineMemo(this, iz);
    }
    clearCofactor() {
      const { h: cofactor2 } = CURVE;
      if (cofactor2 === _1n5)
        return this;
      return this.multiplyUnsafe(cofactor2);
    }
    // Converts hash string or Uint8Array to Point.
    // Uses algo from RFC8032 5.1.3.
    static fromHex(hex3, zip215 = false) {
      const { d, a } = CURVE;
      const len = Fp2.BYTES;
      hex3 = ensureBytes("pointHex", hex3, len);
      abool("zip215", zip215);
      const normed = hex3.slice();
      const lastByte = hex3[len - 1];
      normed[len - 1] = lastByte & ~128;
      const y = bytesToNumberLE(normed);
      const max = zip215 ? MASK : Fp2.ORDER;
      aInRange("pointHex.y", y, _0n5, max);
      const y2 = modP(y * y);
      const u = modP(y2 - _1n5);
      const v = modP(d * y2 - a);
      let { isValid, value: x } = uvRatio2(u, v);
      if (!isValid)
        throw new Error("Point.fromHex: invalid y coordinate");
      const isXOdd = (x & _1n5) === _1n5;
      const isLastByteOdd = (lastByte & 128) !== 0;
      if (!zip215 && x === _0n5 && isLastByteOdd)
        throw new Error("Point.fromHex: x=0 and x_0=1");
      if (isLastByteOdd !== isXOdd)
        x = modP(-x);
      return Point.fromAffine({ x, y });
    }
    static fromPrivateKey(privKey) {
      const { scalar } = getPrivateScalar(privKey);
      return G.multiply(scalar);
    }
    toRawBytes() {
      const { x, y } = this.toAffine();
      const bytes2 = numberToBytesLE(y, Fp2.BYTES);
      bytes2[bytes2.length - 1] |= x & _1n5 ? 128 : 0;
      return bytes2;
    }
    toHex() {
      return bytesToHex(this.toRawBytes());
    }
  }
  Point.BASE = new Point(CURVE.Gx, CURVE.Gy, _1n5, modP(CURVE.Gx * CURVE.Gy));
  Point.ZERO = new Point(_0n5, _1n5, _1n5, _0n5);
  const { BASE: G, ZERO: I } = Point;
  const wnaf = wNAF(Point, nByteLength * 8);
  function modN(a) {
    return mod(a, CURVE_ORDER);
  }
  function modN_LE(hash) {
    return modN(bytesToNumberLE(hash));
  }
  function getPrivateScalar(key) {
    const len = Fp2.BYTES;
    key = ensureBytes("private key", key, len);
    const hashed = ensureBytes("hashed private key", cHash(key), 2 * len);
    const head = adjustScalarBytes2(hashed.slice(0, len));
    const prefix = hashed.slice(len, 2 * len);
    const scalar = modN_LE(head);
    return { head, prefix, scalar };
  }
  function getExtendedPublicKey(key) {
    const { head, prefix, scalar } = getPrivateScalar(key);
    const point = G.multiply(scalar);
    const pointBytes = point.toRawBytes();
    return { head, prefix, scalar, point, pointBytes };
  }
  function getPublicKey(privKey) {
    return getExtendedPublicKey(privKey).pointBytes;
  }
  function hashDomainToScalar(context = Uint8Array.of(), ...msgs) {
    const msg = concatBytes2(...msgs);
    return modN_LE(cHash(domain(msg, ensureBytes("context", context), !!prehash)));
  }
  function sign(msg, privKey, options = {}) {
    msg = ensureBytes("message", msg);
    if (prehash)
      msg = prehash(msg);
    const { prefix, scalar, pointBytes } = getExtendedPublicKey(privKey);
    const r = hashDomainToScalar(options.context, prefix, msg);
    const R = G.multiply(r).toRawBytes();
    const k = hashDomainToScalar(options.context, R, pointBytes, msg);
    const s = modN(r + k * scalar);
    aInRange("signature.s", s, _0n5, CURVE_ORDER);
    const res = concatBytes2(R, numberToBytesLE(s, Fp2.BYTES));
    return ensureBytes("result", res, Fp2.BYTES * 2);
  }
  const verifyOpts = VERIFY_DEFAULT;
  function verify(sig, msg, publicKey, options = verifyOpts) {
    const { context, zip215 } = options;
    const len = Fp2.BYTES;
    sig = ensureBytes("signature", sig, 2 * len);
    msg = ensureBytes("message", msg);
    publicKey = ensureBytes("publicKey", publicKey, len);
    if (zip215 !== void 0)
      abool("zip215", zip215);
    if (prehash)
      msg = prehash(msg);
    const s = bytesToNumberLE(sig.slice(len, 2 * len));
    let A, R, SB;
    try {
      A = Point.fromHex(publicKey, zip215);
      R = Point.fromHex(sig.slice(0, len), zip215);
      SB = G.multiplyUnsafe(s);
    } catch (error) {
      return false;
    }
    if (!zip215 && A.isSmallOrder())
      return false;
    const k = hashDomainToScalar(context, R.toRawBytes(), A.toRawBytes(), msg);
    const RkA = R.add(A.multiplyUnsafe(k));
    return RkA.subtract(SB).clearCofactor().equals(Point.ZERO);
  }
  G._setWindowSize(8);
  const utils = {
    getExtendedPublicKey,
    /** ed25519 priv keys are uniform 32b. No need to check for modulo bias, like in secp256k1. */
    randomPrivateKey: () => randomBytes2(Fp2.BYTES),
    /**
     * We're doing scalar multiplication (used in getPublicKey etc) with precomputed BASE_POINT
     * values. This slows down first getPublicKey() by milliseconds (see Speed section),
     * but allows to speed-up subsequent getPublicKey() calls up to 20x.
     * @param windowSize 2, 4, 8, 16
     */
    precompute(windowSize = 8, point = Point.BASE) {
      point._setWindowSize(windowSize);
      point.multiply(BigInt(3));
      return point;
    }
  };
  return {
    CURVE,
    getPublicKey,
    sign,
    verify,
    ExtendedPoint: Point,
    utils
  };
}
var _0n5, _1n5, _2n3, _8n2, VERIFY_DEFAULT;
var init_edwards = __esm({
  "node_modules/@noble/curves/esm/abstract/edwards.js"() {
    init_curve();
    init_modular();
    init_utils2();
    _0n5 = BigInt(0);
    _1n5 = BigInt(1);
    _2n3 = BigInt(2);
    _8n2 = BigInt(8);
    VERIFY_DEFAULT = { zip215: true };
  }
});

// node_modules/@noble/curves/esm/ed25519.js
function ed25519_pow_2_252_3(x) {
  const _10n = BigInt(10), _20n = BigInt(20), _40n = BigInt(40), _80n = BigInt(80);
  const P = ED25519_P;
  const x2 = x * x % P;
  const b2 = x2 * x % P;
  const b4 = pow2(b2, _2n4, P) * b2 % P;
  const b5 = pow2(b4, _1n6, P) * x % P;
  const b10 = pow2(b5, _5n2, P) * b5 % P;
  const b20 = pow2(b10, _10n, P) * b10 % P;
  const b40 = pow2(b20, _20n, P) * b20 % P;
  const b80 = pow2(b40, _40n, P) * b40 % P;
  const b160 = pow2(b80, _80n, P) * b80 % P;
  const b240 = pow2(b160, _80n, P) * b80 % P;
  const b250 = pow2(b240, _10n, P) * b10 % P;
  const pow_p_5_8 = pow2(b250, _2n4, P) * x % P;
  return { pow_p_5_8, b2 };
}
function adjustScalarBytes(bytes2) {
  bytes2[0] &= 248;
  bytes2[31] &= 127;
  bytes2[31] |= 64;
  return bytes2;
}
function uvRatio(u, v) {
  const P = ED25519_P;
  const v3 = mod(v * v * v, P);
  const v7 = mod(v3 * v3 * v, P);
  const pow = ed25519_pow_2_252_3(u * v7).pow_p_5_8;
  let x = mod(u * v3 * pow, P);
  const vx2 = mod(v * x * x, P);
  const root1 = x;
  const root2 = mod(x * ED25519_SQRT_M1, P);
  const useRoot1 = vx2 === u;
  const useRoot2 = vx2 === mod(-u, P);
  const noRoot = vx2 === mod(-u * ED25519_SQRT_M1, P);
  if (useRoot1)
    x = root1;
  if (useRoot2 || noRoot)
    x = root2;
  if (isNegativeLE(x, P))
    x = mod(-x, P);
  return { isValid: useRoot1 || useRoot2, value: x };
}
var ED25519_P, ED25519_SQRT_M1, _0n6, _1n6, _2n4, _3n3, _5n2, _8n3, Fp, ed25519Defaults, ed25519;
var init_ed25519 = __esm({
  "node_modules/@noble/curves/esm/ed25519.js"() {
    init_sha2();
    init_utils();
    init_edwards();
    init_modular();
    ED25519_P = BigInt("57896044618658097711785492504343953926634992332820282019728792003956564819949");
    ED25519_SQRT_M1 = /* @__PURE__ */ BigInt("19681161376707505956807079304988542015446066515923890162744021073123829784752");
    _0n6 = BigInt(0);
    _1n6 = BigInt(1);
    _2n4 = BigInt(2);
    _3n3 = BigInt(3);
    _5n2 = BigInt(5);
    _8n3 = BigInt(8);
    Fp = /* @__PURE__ */ (() => Field(ED25519_P, void 0, true))();
    ed25519Defaults = /* @__PURE__ */ (() => ({
      // Removing Fp.create() will still work, and is 10% faster on sign
      a: Fp.create(BigInt(-1)),
      // d is -121665/121666 a.k.a. Fp.neg(121665 * Fp.inv(121666))
      d: BigInt("37095705934669439343138083508754565189542113879843219016388785533085940283555"),
      // Finite field 2n**255n - 19n
      Fp,
      // Subgroup order 2n**252n + 27742317777372353535851937790883648493n;
      n: BigInt("7237005577332262213973186563042994240857116359379907606001950938285454250989"),
      h: _8n3,
      Gx: BigInt("15112221349535400772501151409588531511454012693041857206046113283949847762202"),
      Gy: BigInt("46316835694926478169428394003475163141307993866256225615783033603165251855960"),
      hash: sha512,
      randomBytes,
      adjustScalarBytes,
      // dom2
      // Ratio of u to v. Allows us to combine inversion and square root. Uses algo from RFC8032 5.1.3.
      // Constant-time, u/√v
      uvRatio
    }))();
    ed25519 = /* @__PURE__ */ (() => twistedEdwards(ed25519Defaults))();
  }
});

// node_modules/@freedomofpress/crypto-browser/dist/crypto.js
function getSubtle() {
  if (!subtlePromise) {
    subtlePromise = subtleCryptoProxy();
  }
  return subtlePromise;
}
function isFallbackKey(key) {
  return typeof key === "object" && key !== null && key.__fallback__ === true;
}
function toUint8(data) {
  return data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
async function isEd25519Available() {
  try {
    await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
    return true;
  } catch {
    return false;
  }
}
async function subtleCryptoProxy() {
  const nativeSupported = await isEd25519Available();
  const subtle = crypto.subtle;
  if (nativeSupported) {
    return subtle;
  }
  return new Proxy(subtle, {
    get(target, prop) {
      if (prop === "importKey") {
        return async function(format, keyData, algorithm, extractable, usages) {
          if (algorithm?.name === "Ed25519") {
            const bytes2 = toUint8(keyData);
            const type = usages.includes("sign") ? "private" : "public";
            return {
              __fallback__: true,
              algorithm: { name: "Ed25519" },
              type,
              bytes: bytes2
            };
          }
          return format === "jwk" ? target.importKey("jwk", keyData, algorithm, extractable, usages) : target.importKey(format, keyData, algorithm, extractable, usages);
        };
      }
      if (prop === "sign") {
        return async function(algorithm, key, data) {
          if (algorithm?.name === "Ed25519" && isFallbackKey(key)) {
            if (key.type !== "private") {
              throw new DOMException("Invalid key type for signing", "InvalidAccessError");
            }
            const sig = ed25519.sign(toUint8(data), key.bytes);
            return sig.buffer;
          }
          return target.sign(algorithm, key, data);
        };
      }
      if (prop === "verify") {
        return async function(algorithm, key, signature, data) {
          if (algorithm?.name === "Ed25519" && isFallbackKey(key)) {
            if (key.type !== "public") {
              throw new DOMException("Invalid key type for verify", "InvalidAccessError");
            }
            return ed25519.verify(toUint8(signature), toUint8(data), key.bytes);
          }
          return target.verify(algorithm, key, signature, data);
        };
      }
      return target[prop];
    }
  });
}
function pkcs1ToSpki(pkcs1Bytes) {
  const algorithmIdentifier = new Uint8Array([
    48,
    13,
    6,
    9,
    42,
    134,
    72,
    134,
    247,
    13,
    1,
    1,
    1,
    5,
    0
  ]);
  const bitStringLength = pkcs1Bytes.length + 1;
  const totalContentLength = algorithmIdentifier.length + 1 + lengthBytes(bitStringLength).length + bitStringLength;
  const result = new Uint8Array(1 + lengthBytes(totalContentLength).length + totalContentLength);
  let offset = 0;
  result[offset++] = 48;
  const totalLengthBytes = lengthBytes(totalContentLength);
  result.set(totalLengthBytes, offset);
  offset += totalLengthBytes.length;
  result.set(algorithmIdentifier, offset);
  offset += algorithmIdentifier.length;
  result[offset++] = 3;
  const bitStringLengthBytes = lengthBytes(bitStringLength);
  result.set(bitStringLengthBytes, offset);
  offset += bitStringLengthBytes.length;
  result[offset++] = 0;
  result.set(pkcs1Bytes, offset);
  return result;
}
function lengthBytes(length) {
  if (length < 128) {
    return new Uint8Array([length]);
  } else if (length < 256) {
    return new Uint8Array([129, length]);
  } else {
    return new Uint8Array([130, length >> 8 & 255, length & 255]);
  }
}
async function importKey(keytype, scheme, key) {
  class importParams {
    constructor() {
      this.format = "spki";
      this.keyData = new Uint8Array(0);
      this.algorithm = { name: KeyTypes.Ecdsa };
      this.extractable = true;
      this.usage = ["verify"];
    }
  }
  const params = new importParams();
  if (key.includes("BEGIN")) {
    params.format = "spki";
    params.keyData = toDER(key);
  } else if (/^[0-9A-Fa-f]+$/.test(key)) {
    params.format = "raw";
    params.keyData = hexToUint8Array(key);
  } else {
    params.format = "spki";
    const keyBytes = base64ToUint8Array(key);
    if (keytype.toLowerCase().includes("pkcs1") && keyBytes[0] === 48 && keyBytes[1] === 130 && keyBytes[4] === 2 && keyBytes[5] === 130) {
      params.keyData = pkcs1ToSpki(keyBytes);
    } else {
      params.keyData = keyBytes;
    }
  }
  if (keytype.toLowerCase().includes("ecdsa")) {
    if (scheme.includes("256")) {
      params.algorithm = { name: KeyTypes.Ecdsa, namedCurve: EcdsaTypes.P256 };
    } else if (scheme.includes("384")) {
      params.algorithm = { name: KeyTypes.Ecdsa, namedCurve: EcdsaTypes.P384 };
    } else if (scheme.includes("521")) {
      params.algorithm = { name: KeyTypes.Ecdsa, namedCurve: EcdsaTypes.P521 };
    } else {
      throw new Error("Cannot determine ECDSA key size.");
    }
  } else if (keytype.toLowerCase().includes("ed25519")) {
    params.algorithm = { name: KeyTypes.Ed25519 };
  } else if (keytype.toLowerCase().includes("rsa") || keytype.toLowerCase().includes("pkcs1")) {
    let hashName = HashAlgorithms.SHA256;
    const normalizedScheme = scheme.toUpperCase().replace(/[-_]/g, "");
    if (normalizedScheme.includes("SHA256") || normalizedScheme.includes("256")) {
      hashName = HashAlgorithms.SHA256;
    } else if (normalizedScheme.includes("SHA384") || normalizedScheme.includes("384")) {
      hashName = HashAlgorithms.SHA384;
    } else if (normalizedScheme.includes("SHA512") || normalizedScheme.includes("512")) {
      hashName = HashAlgorithms.SHA512;
    }
    if (normalizedScheme.includes(RsaSchemes.PKCS1) || normalizedScheme.includes(RsaSchemes.RSAPKCS1)) {
      params.algorithm = {
        name: RsaAlgorithms.PKCS1v15,
        hash: { name: hashName }
      };
    } else {
      params.algorithm = {
        name: RsaAlgorithms.PSS,
        hash: { name: hashName }
      };
    }
  } else {
    throw new Error(`Unsupported ${keytype}`);
  }
  const subtle = await getSubtle();
  return await subtle.importKey(params.format, params.keyData, params.algorithm, params.extractable, params.usage);
}
async function verifySignature(key, signed, sig, hash = "sha256") {
  const subtle = await getSubtle();
  const options = {
    name: key.algorithm.name
  };
  if (key.algorithm.name === KeyTypes.Ecdsa) {
    const namedCurve = key.algorithm.namedCurve;
    let sig_size = 32;
    if (namedCurve === EcdsaTypes.P256) {
      sig_size = 32;
    } else if (namedCurve === EcdsaTypes.P384) {
      sig_size = 48;
    } else if (namedCurve === EcdsaTypes.P521) {
      sig_size = 66;
    }
    options.hash = { name: "" };
    if (hash.includes("256")) {
      options.hash.name = HashAlgorithms.SHA256;
    } else if (hash.includes("384")) {
      options.hash.name = HashAlgorithms.SHA384;
    } else if (hash.includes("512")) {
      options.hash.name = HashAlgorithms.SHA512;
    } else {
      throw new Error("Cannot determine hashing algorithm;");
    }
    let raw_signature;
    try {
      const asn1_sig = ASN1Obj.parseBuffer(sig);
      const r = asn1_sig.subs[0].toInteger();
      const s = asn1_sig.subs[1].toInteger();
      const binr = hexToUint8Array(r.toString(16).padStart(sig_size * 2, "0"));
      const bins = hexToUint8Array(s.toString(16).padStart(sig_size * 2, "0"));
      raw_signature = new Uint8Array(binr.length + bins.length);
      raw_signature.set(binr, 0);
      raw_signature.set(bins, binr.length);
    } catch {
      return false;
    }
    return await subtle.verify(options, key, raw_signature, signed);
  } else if (key.algorithm.name === KeyTypes.Ed25519) {
    return await subtle.verify({ name: key.algorithm.name }, key, sig, signed);
  } else if (key.algorithm.name === RsaAlgorithms.PSS) {
    const hashAlg = key.algorithm.hash.name;
    const saltLength = hashAlg === HashAlgorithms.SHA256 ? 32 : hashAlg === HashAlgorithms.SHA384 ? 48 : hashAlg === HashAlgorithms.SHA512 ? 64 : 32;
    return await subtle.verify({
      name: RsaAlgorithms.PSS,
      saltLength
    }, key, sig, signed);
  } else if (key.algorithm.name === RsaAlgorithms.PKCS1v15) {
    return await subtle.verify({ name: key.algorithm.name }, key, sig, signed);
  } else {
    throw new Error("Unsupported key type!");
  }
}
async function verifySignatureOverDigest(key, digest, sig) {
  const subtle = await getSubtle();
  if (key.algorithm.name !== KeyTypes.Ecdsa) {
    throw new Error("verifySignatureOverDigest only supports ECDSA keys");
  }
  const namedCurve = key.algorithm.namedCurve;
  let curve;
  if (namedCurve === EcdsaTypes.P256) {
    curve = p256;
  } else if (namedCurve === EcdsaTypes.P384) {
    curve = p384;
  } else if (namedCurve === EcdsaTypes.P521) {
    curve = p521;
  } else {
    throw new Error(`Unsupported curve: ${namedCurve}`);
  }
  const jwk = await subtle.exportKey("jwk", key);
  if (!jwk.x || !jwk.y) {
    throw new Error("Invalid ECDSA public key: missing x or y coordinates");
  }
  const x = base64UrlToUint8Array(jwk.x);
  const y = base64UrlToUint8Array(jwk.y);
  const publicKey = new Uint8Array(1 + x.length + y.length);
  publicKey[0] = 4;
  publicKey.set(x, 1);
  publicKey.set(y, 1 + x.length);
  return curve.verify(sig, digest, publicKey, { format: "der", prehash: false, lowS: false });
}
var subtlePromise;
var init_crypto = __esm({
  "node_modules/@freedomofpress/crypto-browser/dist/crypto.js"() {
    init_asn1();
    init_encoding();
    init_interfaces();
    init_pem();
    init_nist();
    init_ed25519();
    subtlePromise = null;
  }
});

// node_modules/@freedomofpress/crypto-browser/dist/index.js
var init_dist = __esm({
  "node_modules/@freedomofpress/crypto-browser/dist/index.js"() {
    init_error();
    init_tag();
    init_length();
    init_parse();
    init_obj();
    init_stream();
    init_encoding();
    init_pem();
    init_canonicalize();
    init_crypto();
    init_interfaces();
  }
});

// node_modules/@freedomofpress/sigstore-browser/dist/interfaces.js
function getHashAlgorithm(algorithm) {
  const hashAlg = SUPPORTED_HASH_ALGORITHMS[algorithm];
  if (!hashAlg) {
    throw new Error(`Unsupported hash algorithm: ${algorithm}`);
  }
  return hashAlg;
}
var SigstoreRoots, SUPPORTED_HASH_ALGORITHMS;
var init_interfaces2 = __esm({
  "node_modules/@freedomofpress/sigstore-browser/dist/interfaces.js"() {
    init_dist();
    init_dist();
    (function(SigstoreRoots2) {
      SigstoreRoots2["certificateAuthorities"] = "certificateAuthorities";
      SigstoreRoots2["ctlogs"] = "ctlogs";
      SigstoreRoots2["timestampAuthorities"] = "timestampAuthorities";
      SigstoreRoots2["tlogs"] = "tlogs";
    })(SigstoreRoots || (SigstoreRoots = {}));
    SUPPORTED_HASH_ALGORITHMS = {
      "sha256": HashAlgorithms.SHA256,
      "sha384": HashAlgorithms.SHA384,
      "sha512": HashAlgorithms.SHA512,
      "SHA2_256": HashAlgorithms.SHA256,
      "SHA2_384": HashAlgorithms.SHA384,
      "SHA2_512": HashAlgorithms.SHA512
    };
  }
});

// node_modules/@freedomofpress/sigstore-browser/dist/oid.js
var ECDSA_SIGNATURE_ALGOS, RSA_SIGNATURE_ALGOS, OID_RSASSA_PSS, SHA2_HASH_ALGOS, DEFAULT_HASH_ALGORITHM, ECDSA_CURVE_NAMES;
var init_oid = __esm({
  "node_modules/@freedomofpress/sigstore-browser/dist/oid.js"() {
    ECDSA_SIGNATURE_ALGOS = {
      "1.2.840.10045.4.3.1": "sha224",
      "1.2.840.10045.4.3.2": "sha256",
      "1.2.840.10045.4.3.3": "sha384",
      "1.2.840.10045.4.3.4": "sha512"
    };
    RSA_SIGNATURE_ALGOS = {
      "1.2.840.113549.1.1.11": "sha256",
      // sha256WithRSAEncryption
      "1.2.840.113549.1.1.12": "sha384",
      // sha384WithRSAEncryption
      "1.2.840.113549.1.1.13": "sha512",
      // sha512WithRSAEncryption
      "1.2.840.113549.1.1.5": "sha1"
      // sha1WithRSAEncryption
    };
    OID_RSASSA_PSS = "1.2.840.113549.1.1.10";
    SHA2_HASH_ALGOS = {
      "2.16.840.1.101.3.4.2.1": "sha256",
      "2.16.840.1.101.3.4.2.2": "sha384",
      "2.16.840.1.101.3.4.2.3": "sha512"
    };
    DEFAULT_HASH_ALGORITHM = "sha256";
    ECDSA_CURVE_NAMES = {
      "1.2.840.10045.3.1.7": "secp256r1",
      "1.3.132.0.34": "secp384r1",
      "1.3.132.0.35": "secp521r1"
    };
  }
});

// node_modules/@freedomofpress/sigstore-browser/dist/x509/sct.js
var SignedCertificateTimestamp;
var init_sct = __esm({
  "node_modules/@freedomofpress/sigstore-browser/dist/x509/sct.js"() {
    init_dist();
    SignedCertificateTimestamp = class _SignedCertificateTimestamp {
      constructor(options) {
        this.version = options.version;
        this.logID = options.logID;
        this.timestamp = options.timestamp;
        this.extensions = options.extensions;
        this.hashAlgorithm = options.hashAlgorithm;
        this.signatureAlgorithm = options.signatureAlgorithm;
        this.signature = options.signature;
      }
      get datetime() {
        return new Date(Number(readBigInt64BE(this.timestamp)));
      }
      // Returns the hash algorithm used to generate the SCT's signature.
      // https://www.rfc-editor.org/rfc/rfc5246#section-7.4.1.4.1
      get algorithm() {
        switch (this.hashAlgorithm) {
          /* istanbul ignore next */
          case 0:
            return "none";
          /* istanbul ignore next */
          case 1:
            return "md5";
          /* istanbul ignore next */
          case 2:
            return "sha1";
          /* istanbul ignore next */
          case 3:
            return "sha224";
          case 4:
            return "sha256";
          /* istanbul ignore next */
          case 5:
            return "sha384";
          /* istanbul ignore next */
          case 6:
            return "sha512";
          /* istanbul ignore next */
          default:
            return "unknown";
        }
      }
      async verify(preCert, key) {
        const stream = new ByteStream();
        stream.appendChar(this.version);
        stream.appendChar(0);
        stream.appendView(this.timestamp);
        stream.appendUint16(1);
        stream.appendView(preCert);
        stream.appendUint16(this.extensions.byteLength);
        if (this.extensions.byteLength > 0) {
          stream.appendView(this.extensions);
        }
        return await verifySignature(key, stream.buffer, this.signature, this.algorithm);
      }
      // Parses a SignedCertificateTimestamp from a buffer. SCTs are encoded using
      // TLS encoding which means the fields and lengths of most fields are
      // specified as part of the SCT and TLS specs.
      // https://www.rfc-editor.org/rfc/rfc6962#section-3.2
      // https://www.rfc-editor.org/rfc/rfc5246#section-7.4.1.4.1
      static parse(buf) {
        const stream = new ByteStream(buf);
        const version = stream.getUint8();
        if (version !== 0) {
          throw new Error(`Unsupported SCT version: ${version} (expected 0 for v1)`);
        }
        const logID = stream.getBlock(32);
        const timestamp = stream.getBlock(8);
        const extenstionLength = stream.getUint16();
        const extensions = stream.getBlock(extenstionLength);
        const hashAlgorithm = stream.getUint8();
        const signatureAlgorithm = stream.getUint8();
        const sigLength = stream.getUint16();
        const signature = stream.getBlock(sigLength);
        if (stream.position !== buf.length) {
          throw new Error("SCT buffer length mismatch");
        }
        return new _SignedCertificateTimestamp({
          version,
          logID,
          timestamp,
          extensions,
          hashAlgorithm,
          signatureAlgorithm,
          signature
        });
      }
    };
  }
});

// node_modules/@freedomofpress/sigstore-browser/dist/x509/ext.js
var X509Extension, X509BasicConstraintsExtension, X509KeyUsageExtension, X509SubjectAlternativeNameExtension, X509AuthorityKeyIDExtension, X509SubjectKeyIDExtension, X509FulcioExtensionV1, X509FulcioExtensionV2, X509FulcioIssuerV1, X509GitHubWorkflowTriggerExtension, X509GitHubWorkflowSHAExtension, X509GitHubWorkflowNameExtension, X509GitHubWorkflowRepositoryExtension, X509GitHubWorkflowRefExtension, X509FulcioIssuerV2, X509BuildSignerURIExtension, X509BuildSignerDigestExtension, X509RunnerEnvironmentExtension, X509SourceRepositoryURIExtension, X509SourceRepositoryDigestExtension, X509SourceRepositoryRefExtension, X509SourceRepositoryIdentifierExtension, X509SourceRepositoryOwnerURIExtension, X509SourceRepositoryOwnerIdentifierExtension, X509BuildConfigURIExtension, X509BuildConfigDigestExtension, X509BuildTriggerExtension, X509RunInvocationURIExtension, X509SourceRepositoryVisibilityExtension, X509SCTExtension;
var init_ext = __esm({
  "node_modules/@freedomofpress/sigstore-browser/dist/x509/ext.js"() {
    init_dist();
    init_sct();
    X509Extension = class {
      constructor(asn1) {
        this.root = asn1;
      }
      get oid() {
        return this.root.subs[0].toOID();
      }
      get critical() {
        return this.root.subs.length === 3 ? this.root.subs[1].toBoolean() : false;
      }
      get value() {
        return this.extnValueObj.value;
      }
      get valueObj() {
        return this.extnValueObj;
      }
      get extnValueObj() {
        return this.root.subs[this.root.subs.length - 1];
      }
    };
    X509BasicConstraintsExtension = class extends X509Extension {
      get isCA() {
        return this.sequence.subs[0]?.toBoolean() ?? false;
      }
      get pathLenConstraint() {
        return this.sequence.subs.length > 1 ? this.sequence.subs[1].toInteger() : void 0;
      }
      // The extnValue field contains a single sequence wrapping the isCA and
      // pathLenConstraint.
      get sequence() {
        return this.extnValueObj.subs[0];
      }
    };
    X509KeyUsageExtension = class extends X509Extension {
      get digitalSignature() {
        return this.bitString[0] === 1;
      }
      get keyCertSign() {
        return this.bitString[5] === 1;
      }
      get crlSign() {
        return this.bitString[6] === 1;
      }
      // The extnValue field contains a single bit string which is a bit mask
      // indicating which key usages are enabled.
      get bitString() {
        return this.extnValueObj.subs[0].toBitString();
      }
    };
    X509SubjectAlternativeNameExtension = class extends X509Extension {
      get rfc822Name() {
        const rfc822Name = this.findGeneralName(1)?.value;
        if (rfc822Name === void 0) {
          return void 0;
        } else {
          return Uint8ArrayToString(rfc822Name);
        }
      }
      get uri() {
        const uri = this.findGeneralName(6)?.value;
        if (uri === void 0) {
          return void 0;
        } else {
          return Uint8ArrayToString(uri);
        }
      }
      // Retrieve the value of an otherName with the given OID.
      otherName(oid2) {
        const otherName = this.findGeneralName(0);
        if (otherName === void 0) {
          return void 0;
        }
        const otherNameOID = otherName.subs[0].toOID();
        if (otherNameOID !== oid2) {
          return void 0;
        }
        const otherNameValue = otherName.subs[1];
        return Uint8ArrayToString(otherNameValue.subs[0].value);
      }
      findGeneralName(tag) {
        return this.generalNames.find((gn) => gn.tag.isContextSpecific(tag));
      }
      // The extnValue field contains a sequence of GeneralNames.
      get generalNames() {
        return this.extnValueObj.subs[0].subs;
      }
    };
    X509AuthorityKeyIDExtension = class extends X509Extension {
      get keyIdentifier() {
        return this.findSequenceMember(0)?.value;
      }
      findSequenceMember(tag) {
        return this.sequence.subs.find((el) => el.tag.isContextSpecific(tag));
      }
      // The extnValue field contains a single sequence wrapping the keyIdentifier
      get sequence() {
        return this.extnValueObj.subs[0];
      }
    };
    X509SubjectKeyIDExtension = class extends X509Extension {
      get keyIdentifier() {
        return this.extnValueObj.subs[0].value;
      }
    };
    X509FulcioExtensionV1 = class extends X509Extension {
      get stringValue() {
        return Uint8ArrayToString(this.extnValueObj.value);
      }
    };
    X509FulcioExtensionV2 = class extends X509Extension {
      get stringValue() {
        return Uint8ArrayToString(this.extnValueObj.subs[0].value);
      }
    };
    X509FulcioIssuerV1 = class extends X509FulcioExtensionV1 {
      get issuer() {
        return this.stringValue;
      }
    };
    X509GitHubWorkflowTriggerExtension = class extends X509FulcioExtensionV1 {
      get workflowTrigger() {
        return this.stringValue;
      }
    };
    X509GitHubWorkflowSHAExtension = class extends X509FulcioExtensionV1 {
      get workflowSHA() {
        return this.stringValue;
      }
    };
    X509GitHubWorkflowNameExtension = class extends X509FulcioExtensionV1 {
      get workflowName() {
        return this.stringValue;
      }
    };
    X509GitHubWorkflowRepositoryExtension = class extends X509FulcioExtensionV1 {
      get workflowRepository() {
        return this.stringValue;
      }
    };
    X509GitHubWorkflowRefExtension = class extends X509FulcioExtensionV1 {
      get workflowRef() {
        return this.stringValue;
      }
    };
    X509FulcioIssuerV2 = class extends X509FulcioExtensionV2 {
      get issuer() {
        return this.stringValue;
      }
    };
    X509BuildSignerURIExtension = class extends X509FulcioExtensionV2 {
      get buildSignerURI() {
        return this.stringValue;
      }
    };
    X509BuildSignerDigestExtension = class extends X509FulcioExtensionV2 {
      get buildSignerDigest() {
        return this.stringValue;
      }
    };
    X509RunnerEnvironmentExtension = class extends X509FulcioExtensionV2 {
      get runnerEnvironment() {
        return this.stringValue;
      }
    };
    X509SourceRepositoryURIExtension = class extends X509FulcioExtensionV2 {
      get sourceRepositoryURI() {
        return this.stringValue;
      }
    };
    X509SourceRepositoryDigestExtension = class extends X509FulcioExtensionV2 {
      get sourceRepositoryDigest() {
        return this.stringValue;
      }
    };
    X509SourceRepositoryRefExtension = class extends X509FulcioExtensionV2 {
      get sourceRepositoryRef() {
        return this.stringValue;
      }
    };
    X509SourceRepositoryIdentifierExtension = class extends X509FulcioExtensionV2 {
      get sourceRepositoryIdentifier() {
        return this.stringValue;
      }
    };
    X509SourceRepositoryOwnerURIExtension = class extends X509FulcioExtensionV2 {
      get sourceRepositoryOwnerURI() {
        return this.stringValue;
      }
    };
    X509SourceRepositoryOwnerIdentifierExtension = class extends X509FulcioExtensionV2 {
      get sourceRepositoryOwnerIdentifier() {
        return this.stringValue;
      }
    };
    X509BuildConfigURIExtension = class extends X509FulcioExtensionV2 {
      get buildConfigURI() {
        return this.stringValue;
      }
    };
    X509BuildConfigDigestExtension = class extends X509FulcioExtensionV2 {
      get buildConfigDigest() {
        return this.stringValue;
      }
    };
    X509BuildTriggerExtension = class extends X509FulcioExtensionV2 {
      get buildTrigger() {
        return this.stringValue;
      }
    };
    X509RunInvocationURIExtension = class extends X509FulcioExtensionV2 {
      get runInvocationURI() {
        return this.stringValue;
      }
    };
    X509SourceRepositoryVisibilityExtension = class extends X509FulcioExtensionV2 {
      get sourceRepositoryVisibility() {
        return this.stringValue;
      }
    };
    X509SCTExtension = class extends X509Extension {
      constructor(asn1) {
        super(asn1);
      }
      get signedCertificateTimestamps() {
        const buf = this.extnValueObj.subs[0].value;
        const stream = new ByteStream(buf);
        const end = stream.getUint16() + 2;
        const sctList = [];
        while (stream.position < end) {
          const sctLength = stream.getUint16();
          const sct = stream.getBlock(sctLength);
          sctList.push(SignedCertificateTimestamp.parse(sct));
        }
        if (stream.position !== end) {
          throw new Error("SCT list length does not match actual length");
        }
        return sctList;
      }
    };
  }
});

// node_modules/@freedomofpress/sigstore-browser/dist/x509/cert.js
var EXTENSION_OID_SUBJECT_KEY_ID, EXTENSION_OID_KEY_USAGE, EXTENSION_OID_SUBJECT_ALT_NAME, EXTENSION_OID_BASIC_CONSTRAINTS, EXTENSION_OID_AUTHORITY_KEY_ID, EXTENSION_OID_SCT, DN_OID_COMMON_NAME, DN_OID_COUNTRY, DN_OID_LOCALITY, DN_OID_STATE, DN_OID_ORGANIZATION, DN_OID_ORGANIZATIONAL_UNIT, DN_OID_TO_NAME, EXTENSION_OID_FULCIO_ISSUER_V1, EXTENSION_OID_GITHUB_WORKFLOW_TRIGGER, EXTENSION_OID_GITHUB_WORKFLOW_SHA, EXTENSION_OID_GITHUB_WORKFLOW_NAME, EXTENSION_OID_GITHUB_WORKFLOW_REPOSITORY, EXTENSION_OID_GITHUB_WORKFLOW_REF, EXTENSION_OID_OTHERNAME, EXTENSION_OID_FULCIO_ISSUER_V2, EXTENSION_OID_BUILD_SIGNER_URI, EXTENSION_OID_BUILD_SIGNER_DIGEST, EXTENSION_OID_RUNNER_ENVIRONMENT, EXTENSION_OID_SOURCE_REPOSITORY_URI, EXTENSION_OID_SOURCE_REPOSITORY_DIGEST, EXTENSION_OID_SOURCE_REPOSITORY_REF, EXTENSION_OID_SOURCE_REPOSITORY_IDENTIFIER, EXTENSION_OID_SOURCE_REPOSITORY_OWNER_URI, EXTENSION_OID_SOURCE_REPOSITORY_OWNER_IDENTIFIER, EXTENSION_OID_BUILD_CONFIG_URI, EXTENSION_OID_BUILD_CONFIG_DIGEST, EXTENSION_OID_BUILD_TRIGGER, EXTENSION_OID_RUN_INVOCATION_URI, EXTENSION_OID_SOURCE_REPOSITORY_VISIBILITY, X509Certificate4;
var init_cert = __esm({
  "node_modules/@freedomofpress/sigstore-browser/dist/x509/cert.js"() {
    init_dist();
    init_interfaces2();
    init_oid();
    init_ext();
    EXTENSION_OID_SUBJECT_KEY_ID = "2.5.29.14";
    EXTENSION_OID_KEY_USAGE = "2.5.29.15";
    EXTENSION_OID_SUBJECT_ALT_NAME = "2.5.29.17";
    EXTENSION_OID_BASIC_CONSTRAINTS = "2.5.29.19";
    EXTENSION_OID_AUTHORITY_KEY_ID = "2.5.29.35";
    EXTENSION_OID_SCT = "1.3.6.1.4.1.11129.2.4.2";
    DN_OID_COMMON_NAME = "2.5.4.3";
    DN_OID_COUNTRY = "2.5.4.6";
    DN_OID_LOCALITY = "2.5.4.7";
    DN_OID_STATE = "2.5.4.8";
    DN_OID_ORGANIZATION = "2.5.4.10";
    DN_OID_ORGANIZATIONAL_UNIT = "2.5.4.11";
    DN_OID_TO_NAME = {
      [DN_OID_COMMON_NAME]: "CN",
      [DN_OID_COUNTRY]: "C",
      [DN_OID_LOCALITY]: "L",
      [DN_OID_STATE]: "ST",
      [DN_OID_ORGANIZATION]: "O",
      [DN_OID_ORGANIZATIONAL_UNIT]: "OU"
    };
    EXTENSION_OID_FULCIO_ISSUER_V1 = "1.3.6.1.4.1.57264.1.1";
    EXTENSION_OID_GITHUB_WORKFLOW_TRIGGER = "1.3.6.1.4.1.57264.1.2";
    EXTENSION_OID_GITHUB_WORKFLOW_SHA = "1.3.6.1.4.1.57264.1.3";
    EXTENSION_OID_GITHUB_WORKFLOW_NAME = "1.3.6.1.4.1.57264.1.4";
    EXTENSION_OID_GITHUB_WORKFLOW_REPOSITORY = "1.3.6.1.4.1.57264.1.5";
    EXTENSION_OID_GITHUB_WORKFLOW_REF = "1.3.6.1.4.1.57264.1.6";
    EXTENSION_OID_OTHERNAME = "1.3.6.1.4.1.57264.1.7";
    EXTENSION_OID_FULCIO_ISSUER_V2 = "1.3.6.1.4.1.57264.1.8";
    EXTENSION_OID_BUILD_SIGNER_URI = "1.3.6.1.4.1.57264.1.9";
    EXTENSION_OID_BUILD_SIGNER_DIGEST = "1.3.6.1.4.1.57264.1.10";
    EXTENSION_OID_RUNNER_ENVIRONMENT = "1.3.6.1.4.1.57264.1.11";
    EXTENSION_OID_SOURCE_REPOSITORY_URI = "1.3.6.1.4.1.57264.1.12";
    EXTENSION_OID_SOURCE_REPOSITORY_DIGEST = "1.3.6.1.4.1.57264.1.13";
    EXTENSION_OID_SOURCE_REPOSITORY_REF = "1.3.6.1.4.1.57264.1.14";
    EXTENSION_OID_SOURCE_REPOSITORY_IDENTIFIER = "1.3.6.1.4.1.57264.1.15";
    EXTENSION_OID_SOURCE_REPOSITORY_OWNER_URI = "1.3.6.1.4.1.57264.1.16";
    EXTENSION_OID_SOURCE_REPOSITORY_OWNER_IDENTIFIER = "1.3.6.1.4.1.57264.1.17";
    EXTENSION_OID_BUILD_CONFIG_URI = "1.3.6.1.4.1.57264.1.18";
    EXTENSION_OID_BUILD_CONFIG_DIGEST = "1.3.6.1.4.1.57264.1.19";
    EXTENSION_OID_BUILD_TRIGGER = "1.3.6.1.4.1.57264.1.20";
    EXTENSION_OID_RUN_INVOCATION_URI = "1.3.6.1.4.1.57264.1.21";
    EXTENSION_OID_SOURCE_REPOSITORY_VISIBILITY = "1.3.6.1.4.1.57264.1.22";
    X509Certificate4 = class _X509Certificate {
      constructor(asn1) {
        this.root = asn1;
      }
      static parse(cert) {
        const der = typeof cert === "string" ? toDER(cert) : cert;
        const asn1 = ASN1Obj.parseBuffer(der);
        return new _X509Certificate(asn1);
      }
      get tbsCertificate() {
        return this.tbsCertificateObj;
      }
      get version() {
        const ver = this.versionObj.subs[0].toInteger();
        return `v${(ver + BigInt(1)).toString()}`;
      }
      get serialNumber() {
        return this.serialNumberObj.value;
      }
      get notBefore() {
        return this.validityObj.subs[0].toDate();
      }
      get notAfter() {
        return this.validityObj.subs[1].toDate();
      }
      get issuer() {
        return this.issuerObj.value;
      }
      get subject() {
        return this.subjectObj.value;
      }
      /**
       * Returns the issuer distinguished name as a Map of attribute names to values.
       * Common attributes: CN (Common Name), O (Organization), L (Locality),
       * ST (State), C (Country), OU (Organizational Unit)
       */
      get issuerDN() {
        return this.parseDistinguishedName(this.issuerObj);
      }
      /**
       * Returns the subject distinguished name as a Map of attribute names to values.
       * Common attributes: CN (Common Name), O (Organization), L (Locality),
       * ST (State), C (Country), OU (Organizational Unit)
       */
      get subjectDN() {
        return this.parseDistinguishedName(this.subjectObj);
      }
      get publicKey() {
        return this.subjectPublicKeyInfoObj.toDER();
      }
      /**
       * Import the public key with a specific hash algorithm and signature scheme for RSA keys.
       * For ECDSA keys, both parameters are ignored.
       * @param hashAlg - Hash algorithm (e.g., "sha384") for RSA keys
       * @param usePss - If true, import as RSA-PSS key; if false, import as PKCS#1 v1.5
       */
      async getPublicKeyObj(hashAlg, usePss) {
        const publicKey = this.subjectPublicKeyInfoObj.toDER();
        const spki = ASN1Obj.parseBuffer(publicKey);
        const algorithmOID = spki.subs[0].subs[0].toOID();
        const isRsaKey = algorithmOID === "1.2.840.113549.1.1.1";
        const isRsaPssKey = algorithmOID === OID_RSASSA_PSS;
        if (isRsaPssKey) {
          throw new Error("RSA-PSS public keys (id-RSASSA-PSS OID) are not supported by WebCrypto. Only certificates with standard RSA keys (rsaEncryption OID) signed using RSA-PSS are supported.");
        }
        if (isRsaKey) {
          const hash = hashAlg || DEFAULT_HASH_ALGORITHM;
          const scheme = usePss ? hash : `PKCS1_${hash}`;
          return importKey(KeyTypes.RSA, scheme, Uint8ArrayToBase64(publicKey));
        } else {
          const curveOID = spki.subs[0].subs[1]?.toOID();
          const curve = ECDSA_CURVE_NAMES[curveOID];
          if (!curve) {
            throw new Error(`Unknown ECDSA curve OID: ${curveOID}`);
          }
          return importKey(KeyTypes.Ecdsa, curve, Uint8ArrayToBase64(publicKey));
        }
      }
      get publicKeyObj() {
        return this.getPublicKeyObj();
      }
      get signatureAlgorithm() {
        const oid2 = this.signatureAlgorithmObj.subs[0].toOID();
        return ECDSA_SIGNATURE_ALGOS[oid2] || RSA_SIGNATURE_ALGOS[oid2] || this.parseRsaPssHashAlgorithm();
      }
      get signatureAlgorithmOid() {
        return this.signatureAlgorithmObj.subs[0].toOID();
      }
      /**
       * Parse hash algorithm from RSA-PSS signature algorithm parameters.
       * RSA-PSS parameters are: SEQUENCE { hashAlgorithm, maskGenAlgorithm, saltLength, trailerField }
       */
      parseRsaPssHashAlgorithm() {
        const sigAlgOid = this.signatureAlgorithmObj.subs[0].toOID();
        if (sigAlgOid !== OID_RSASSA_PSS) {
          return "";
        }
        const params = this.signatureAlgorithmObj.subs[1];
        if (!params || params.subs.length === 0) {
          return DEFAULT_HASH_ALGORITHM;
        }
        const hashAlgWrapper = params.subs[0];
        if (hashAlgWrapper && hashAlgWrapper.subs.length > 0) {
          const hashAlgSeq = hashAlgWrapper.subs[0];
          if (hashAlgSeq && hashAlgSeq.subs.length > 0) {
            const hashOid = hashAlgSeq.subs[0].toOID();
            return SHA2_HASH_ALGOS[hashOid] || DEFAULT_HASH_ALGORITHM;
          }
        }
        return DEFAULT_HASH_ALGORITHM;
      }
      get signatureValue() {
        return this.signatureValueObj.value.subarray(1);
      }
      get subjectAltName() {
        const ext2 = this.extSubjectAltName;
        return ext2?.uri || ext2?.rfc822Name;
      }
      get extensions() {
        const extSeq = this.extensionsObj?.subs[0];
        return extSeq?.subs || /* istanbul ignore next */
        [];
      }
      get extKeyUsage() {
        const ext2 = this.findExtension(EXTENSION_OID_KEY_USAGE);
        return ext2 ? new X509KeyUsageExtension(ext2) : void 0;
      }
      get extBasicConstraints() {
        const ext2 = this.findExtension(EXTENSION_OID_BASIC_CONSTRAINTS);
        return ext2 ? new X509BasicConstraintsExtension(ext2) : void 0;
      }
      get extSubjectAltName() {
        const ext2 = this.findExtension(EXTENSION_OID_SUBJECT_ALT_NAME);
        return ext2 ? new X509SubjectAlternativeNameExtension(ext2) : void 0;
      }
      get extAuthorityKeyID() {
        const ext2 = this.findExtension(EXTENSION_OID_AUTHORITY_KEY_ID);
        return ext2 ? new X509AuthorityKeyIDExtension(ext2) : void 0;
      }
      get extSubjectKeyID() {
        const ext2 = this.findExtension(EXTENSION_OID_SUBJECT_KEY_ID);
        return ext2 ? new X509SubjectKeyIDExtension(ext2) : (
          /* istanbul ignore next */
          void 0
        );
      }
      get extSCT() {
        const ext2 = this.findExtension(EXTENSION_OID_SCT);
        return ext2 ? new X509SCTExtension(ext2) : void 0;
      }
      get extFulcioIssuerV1() {
        const ext2 = this.findExtension(EXTENSION_OID_FULCIO_ISSUER_V1);
        return ext2 ? new X509FulcioIssuerV1(ext2) : void 0;
      }
      get extFulcioIssuerV2() {
        const ext2 = this.findExtension(EXTENSION_OID_FULCIO_ISSUER_V2);
        return ext2 ? new X509FulcioIssuerV2(ext2) : void 0;
      }
      get extGitHubWorkflowTrigger() {
        const ext2 = this.findExtension(EXTENSION_OID_GITHUB_WORKFLOW_TRIGGER);
        return ext2 ? new X509GitHubWorkflowTriggerExtension(ext2) : void 0;
      }
      get extGitHubWorkflowSHA() {
        const ext2 = this.findExtension(EXTENSION_OID_GITHUB_WORKFLOW_SHA);
        return ext2 ? new X509GitHubWorkflowSHAExtension(ext2) : void 0;
      }
      get extGitHubWorkflowName() {
        const ext2 = this.findExtension(EXTENSION_OID_GITHUB_WORKFLOW_NAME);
        return ext2 ? new X509GitHubWorkflowNameExtension(ext2) : void 0;
      }
      get extGitHubWorkflowRepository() {
        const ext2 = this.findExtension(EXTENSION_OID_GITHUB_WORKFLOW_REPOSITORY);
        return ext2 ? new X509GitHubWorkflowRepositoryExtension(ext2) : void 0;
      }
      get extGitHubWorkflowRef() {
        const ext2 = this.findExtension(EXTENSION_OID_GITHUB_WORKFLOW_REF);
        return ext2 ? new X509GitHubWorkflowRefExtension(ext2) : void 0;
      }
      get extBuildSignerURI() {
        const ext2 = this.findExtension(EXTENSION_OID_BUILD_SIGNER_URI);
        return ext2 ? new X509BuildSignerURIExtension(ext2) : void 0;
      }
      get extBuildSignerDigest() {
        const ext2 = this.findExtension(EXTENSION_OID_BUILD_SIGNER_DIGEST);
        return ext2 ? new X509BuildSignerDigestExtension(ext2) : void 0;
      }
      get extRunnerEnvironment() {
        const ext2 = this.findExtension(EXTENSION_OID_RUNNER_ENVIRONMENT);
        return ext2 ? new X509RunnerEnvironmentExtension(ext2) : void 0;
      }
      get extSourceRepositoryURI() {
        const ext2 = this.findExtension(EXTENSION_OID_SOURCE_REPOSITORY_URI);
        return ext2 ? new X509SourceRepositoryURIExtension(ext2) : void 0;
      }
      get extSourceRepositoryDigest() {
        const ext2 = this.findExtension(EXTENSION_OID_SOURCE_REPOSITORY_DIGEST);
        return ext2 ? new X509SourceRepositoryDigestExtension(ext2) : void 0;
      }
      get extSourceRepositoryRef() {
        const ext2 = this.findExtension(EXTENSION_OID_SOURCE_REPOSITORY_REF);
        return ext2 ? new X509SourceRepositoryRefExtension(ext2) : void 0;
      }
      get extSourceRepositoryIdentifier() {
        const ext2 = this.findExtension(EXTENSION_OID_SOURCE_REPOSITORY_IDENTIFIER);
        return ext2 ? new X509SourceRepositoryIdentifierExtension(ext2) : void 0;
      }
      get extSourceRepositoryOwnerURI() {
        const ext2 = this.findExtension(EXTENSION_OID_SOURCE_REPOSITORY_OWNER_URI);
        return ext2 ? new X509SourceRepositoryOwnerURIExtension(ext2) : void 0;
      }
      get extSourceRepositoryOwnerIdentifier() {
        const ext2 = this.findExtension(EXTENSION_OID_SOURCE_REPOSITORY_OWNER_IDENTIFIER);
        return ext2 ? new X509SourceRepositoryOwnerIdentifierExtension(ext2) : void 0;
      }
      get extBuildConfigURI() {
        const ext2 = this.findExtension(EXTENSION_OID_BUILD_CONFIG_URI);
        return ext2 ? new X509BuildConfigURIExtension(ext2) : void 0;
      }
      get extBuildConfigDigest() {
        const ext2 = this.findExtension(EXTENSION_OID_BUILD_CONFIG_DIGEST);
        return ext2 ? new X509BuildConfigDigestExtension(ext2) : void 0;
      }
      get extBuildTrigger() {
        const ext2 = this.findExtension(EXTENSION_OID_BUILD_TRIGGER);
        return ext2 ? new X509BuildTriggerExtension(ext2) : void 0;
      }
      get extRunInvocationURI() {
        const ext2 = this.findExtension(EXTENSION_OID_RUN_INVOCATION_URI);
        return ext2 ? new X509RunInvocationURIExtension(ext2) : void 0;
      }
      get extSourceRepositoryVisibility() {
        const ext2 = this.findExtension(EXTENSION_OID_SOURCE_REPOSITORY_VISIBILITY);
        return ext2 ? new X509SourceRepositoryVisibilityExtension(ext2) : void 0;
      }
      get isCA() {
        const ca = this.extBasicConstraints?.isCA || false;
        if (this.extKeyUsage) {
          return ca && this.extKeyUsage.keyCertSign;
        }
        return ca;
      }
      extension(oid2) {
        const ext2 = this.findExtension(oid2);
        return ext2 ? new X509Extension(ext2) : void 0;
      }
      async verify(issuerCertificate) {
        const sigAlgOID = this.signatureAlgorithmOid;
        const isRsaPss = sigAlgOID === OID_RSASSA_PSS;
        const hashAlg = isRsaPss ? this.parseRsaPssHashAlgorithm() : RSA_SIGNATURE_ALGOS[sigAlgOID] || ECDSA_SIGNATURE_ALGOS[sigAlgOID];
        const publicKeyObj = issuerCertificate ? await issuerCertificate.getPublicKeyObj(hashAlg, isRsaPss) : await this.getPublicKeyObj(hashAlg, isRsaPss);
        return await verifySignature(publicKeyObj, this.tbsCertificate.toDER(), this.signatureValue, this.signatureAlgorithm);
      }
      validForDate(date) {
        return this.notBefore <= date && date <= this.notAfter;
      }
      equals(other) {
        return uint8ArrayEqual(this.root.toDER(), other.root.toDER());
      }
      // Creates a copy of the certificate with a new buffer
      clone() {
        const der = this.root.toDER();
        const clone = new Uint8Array(der);
        return _X509Certificate.parse(clone);
      }
      findExtension(oid2) {
        return this.extensions.find((ext2) => ext2.subs[0].toOID() === oid2);
      }
      /////////////////////////////////////////////////////////////////////////////
      // The following properties use the documented x509 structure to locate the
      // desired ASN.1 object
      // https://www.rfc-editor.org/rfc/rfc5280#section-4.1
      // https://www.rfc-editor.org/rfc/rfc5280#section-4.1.1.1
      get tbsCertificateObj() {
        return this.root.subs[0];
      }
      // https://www.rfc-editor.org/rfc/rfc5280#section-4.1.1.2
      get signatureAlgorithmObj() {
        return this.root.subs[1];
      }
      // https://www.rfc-editor.org/rfc/rfc5280#section-4.1.1.3
      get signatureValueObj() {
        return this.root.subs[2];
      }
      // https://www.rfc-editor.org/rfc/rfc5280#section-4.1.2.1
      get versionObj() {
        return this.tbsCertificateObj.subs[0];
      }
      // https://www.rfc-editor.org/rfc/rfc5280#section-4.1.2.2
      get serialNumberObj() {
        return this.tbsCertificateObj.subs[1];
      }
      // https://www.rfc-editor.org/rfc/rfc5280#section-4.1.2.4
      get issuerObj() {
        return this.tbsCertificateObj.subs[3];
      }
      // https://www.rfc-editor.org/rfc/rfc5280#section-4.1.2.5
      get validityObj() {
        return this.tbsCertificateObj.subs[4];
      }
      // https://www.rfc-editor.org/rfc/rfc5280#section-4.1.2.6
      get subjectObj() {
        return this.tbsCertificateObj.subs[5];
      }
      // https://www.rfc-editor.org/rfc/rfc5280#section-4.1.2.7
      get subjectPublicKeyInfoObj() {
        return this.tbsCertificateObj.subs[6];
      }
      // Extensions can't be located by index because their position varies. Instead,
      // we need to find the extensions context specific tag
      // https://www.rfc-editor.org/rfc/rfc5280#section-4.1.2.9
      get extensionsObj() {
        return this.tbsCertificateObj.subs.find((sub) => sub.tag.isContextSpecific(3));
      }
      // Parse a Distinguished Name (issuer or subject) ASN1Obj into a Map
      // DN structure: SEQUENCE of SET of SEQUENCE (AttributeTypeAndValue)
      // Each AttributeTypeAndValue is [OID, value]
      parseDistinguishedName(dnObj) {
        const result = /* @__PURE__ */ new Map();
        for (const rdn of dnObj.subs) {
          for (const atv of rdn.subs) {
            if (atv.subs.length >= 2) {
              const oidObj = atv.subs[0];
              const valueObj = atv.subs[1];
              if (oidObj.tag.isOID()) {
                const oid2 = oidObj.toOID();
                const attrName = DN_OID_TO_NAME[oid2];
                if (attrName) {
                  const value = new TextDecoder().decode(valueObj.value);
                  result.set(attrName, value);
                }
              }
            }
          }
        }
        return result;
      }
    };
  }
});

// node_modules/@freedomofpress/sigstore-browser/dist/x509/chain.js
function dedupeCertificates(certs) {
  for (let i = 0; i < certs.length; i++) {
    for (let j = i + 1; j < certs.length; j++) {
      if (certs[i].equals(certs[j])) {
        certs.splice(j, 1);
        j--;
      }
    }
  }
  return certs;
}
var CertificateChainVerifier;
var init_chain = __esm({
  "node_modules/@freedomofpress/sigstore-browser/dist/x509/chain.js"() {
    init_dist();
    CertificateChainVerifier = class {
      constructor(opts) {
        this.untrustedCert = opts.untrustedCert;
        this.trustedCerts = opts.trustedCerts;
        this.localCerts = dedupeCertificates([
          ...opts.trustedCerts,
          opts.untrustedCert
        ]);
        this.timestamp = opts.timestamp;
      }
      async verify() {
        const certificatePath = await this.sort();
        this.checkPath(certificatePath);
        const validForDate = certificatePath.every((cert) => cert.validForDate(this.timestamp));
        if (!validForDate) {
          throw new Error("certificate is not valid or expired at the specified date");
        }
        return certificatePath;
      }
      async sort() {
        const leafCert = this.untrustedCert;
        let paths = await this.buildPaths(leafCert);
        paths = paths.filter((path6) => path6.some((cert) => this.trustedCerts.includes(cert)));
        if (paths.length === 0) {
          throw new Error("no trusted certificate path found");
        }
        const path5 = paths.reduce((prev, curr) => prev.length < curr.length ? prev : curr);
        return [leafCert, ...path5].slice(0, -1);
      }
      async buildPaths(certificate) {
        const paths = [];
        const issuers = await this.findIssuer(certificate);
        if (issuers.length === 0) {
          throw new Error("no valid certificate path found");
        }
        for (let i = 0; i < issuers.length; i++) {
          const issuer = issuers[i];
          if (issuer.equals(certificate)) {
            paths.push([certificate]);
            continue;
          }
          const subPaths = await this.buildPaths(issuer);
          for (let j = 0; j < subPaths.length; j++) {
            paths.push([issuer, ...subPaths[j]]);
          }
        }
        return paths;
      }
      async findIssuer(certificate) {
        let issuers = [];
        let keyIdentifier;
        if (uint8ArrayEqual(certificate.subject, certificate.issuer)) {
          if (await certificate.verify()) {
            return [certificate];
          }
        }
        if (certificate.extAuthorityKeyID) {
          keyIdentifier = certificate.extAuthorityKeyID.keyIdentifier;
        }
        this.localCerts.forEach((possibleIssuer) => {
          if (keyIdentifier) {
            if (possibleIssuer.extSubjectKeyID) {
              if (uint8ArrayEqual(possibleIssuer.extSubjectKeyID.keyIdentifier, keyIdentifier)) {
                issuers.push(possibleIssuer);
              }
              return;
            }
          }
          if (uint8ArrayEqual(possibleIssuer.subject, certificate.issuer)) {
            issuers.push(possibleIssuer);
          }
        });
        const verifiedIssuers = [];
        for (const issuer of issuers) {
          try {
            if (await certificate.verify(issuer)) {
              verifiedIssuers.push(issuer);
            }
          } catch (ex) {
          }
        }
        return verifiedIssuers;
      }
      checkPath(path5) {
        if (path5.length < 1) {
          throw new Error("certificate chain must contain at least one certificate");
        }
        const validCAs = path5.slice(1).every((cert) => cert.isCA);
        if (!validCAs) {
          throw new Error("intermediate certificate is not a CA");
        }
        for (let i = path5.length - 2; i >= 0; i--) {
          if (!uint8ArrayEqual(path5[i].issuer, path5[i + 1].subject)) {
            throw new Error("incorrect certificate name chaining");
          }
        }
        for (let i = 0; i < path5.length; i++) {
          const cert = path5[i];
          if (cert.extBasicConstraints?.isCA) {
            const pathLength = cert.extBasicConstraints.pathLenConstraint;
            if (pathLength !== void 0 && pathLength < BigInt(i - 1)) {
              throw new Error("path length constraint exceeded");
            }
          }
        }
      }
    };
  }
});

// node_modules/@freedomofpress/sigstore-browser/dist/x509/index.js
var init_x509 = __esm({
  "node_modules/@freedomofpress/sigstore-browser/dist/x509/index.js"() {
    init_cert();
    init_ext();
    init_chain();
  }
});

// node_modules/@freedomofpress/sigstore-browser/dist/dsse.js
function preAuthEncoding(payloadType, payload) {
  const prefix = [
    PAE_PREFIX,
    payloadType.length,
    payloadType,
    payload.length,
    ""
  ].join(" ");
  const encoder = new TextEncoder();
  const prefixBuffer = encoder.encode(prefix);
  for (let i = 0; i < prefixBuffer.length; i++) {
    if (prefixBuffer[i] > 127) {
      throw new Error(`Invalid non-ASCII character in PAE prefix at position ${i}`);
    }
  }
  const combinedArray = new Uint8Array(prefixBuffer.length + payload.length);
  combinedArray.set(prefixBuffer, 0);
  combinedArray.set(payload, prefixBuffer.length);
  return combinedArray;
}
var PAE_PREFIX;
var init_dsse = __esm({
  "node_modules/@freedomofpress/sigstore-browser/dist/dsse.js"() {
    PAE_PREFIX = "DSSEv1";
  }
});

// node_modules/@freedomofpress/sigstore-browser/dist/tlog/merkle.js
async function verifyMerkleInclusion(entry) {
  if (!entry.inclusionProof) {
    throw new Error("Missing inclusion proof");
  }
  const inclusionProof = entry.inclusionProof;
  const logIndex = BigInt(inclusionProof.logIndex);
  const treeSize = BigInt(inclusionProof.treeSize);
  if (logIndex < 0n || logIndex >= treeSize) {
    throw new Error(`Invalid log index: ${logIndex}`);
  }
  const { inner, border } = decompInclProof(logIndex, treeSize);
  if (inclusionProof.hashes.length !== inner + border) {
    throw new Error("Invalid hash count in inclusion proof");
  }
  const innerHashes = inclusionProof.hashes.slice(0, inner).map((h) => base64ToUint8Array(h));
  const borderHashes = inclusionProof.hashes.slice(inner).map((h) => base64ToUint8Array(h));
  const leafHash = await hashLeaf(base64ToUint8Array(entry.canonicalizedBody));
  const calculatedHash = await chainBorderRight(await chainInner(leafHash, innerHashes, logIndex), borderHashes);
  const rootHash = base64ToUint8Array(inclusionProof.rootHash);
  if (!uint8ArrayEqual(calculatedHash, rootHash)) {
    throw new Error("Calculated root hash does not match inclusion proof");
  }
}
function decompInclProof(index, size) {
  const inner = innerProofSize(index, size);
  const border = onesCount(index >> BigInt(inner));
  return { inner, border };
}
async function chainInner(seed, hashes, index) {
  let acc = seed;
  for (let i = 0; i < hashes.length; i++) {
    const h = hashes[i];
    if (index >> BigInt(i) & BigInt(1)) {
      acc = await hashChildren(h, acc);
    } else {
      acc = await hashChildren(acc, h);
    }
  }
  return acc;
}
async function chainBorderRight(seed, hashes) {
  let acc = seed;
  for (const h of hashes) {
    acc = await hashChildren(h, acc);
  }
  return acc;
}
function innerProofSize(index, size) {
  return bitLength(index ^ size - BigInt(1));
}
function onesCount(num) {
  return num.toString(2).split("1").length - 1;
}
function bitLength(n) {
  if (n === 0n) {
    return 0;
  }
  return n.toString(2).length;
}
async function hashChildren(left, right) {
  const data = new Uint8Array(RFC6962_NODE_HASH_PREFIX.length + left.length + right.length);
  data.set(RFC6962_NODE_HASH_PREFIX, 0);
  data.set(left, RFC6962_NODE_HASH_PREFIX.length);
  data.set(right, RFC6962_NODE_HASH_PREFIX.length + left.length);
  const hash = await crypto.subtle.digest(HashAlgorithms.SHA256, data);
  return new Uint8Array(hash);
}
async function hashLeaf(leaf) {
  const data = new Uint8Array(RFC6962_LEAF_HASH_PREFIX.length + leaf.length);
  data.set(RFC6962_LEAF_HASH_PREFIX, 0);
  data.set(leaf, RFC6962_LEAF_HASH_PREFIX.length);
  const hash = await crypto.subtle.digest(HashAlgorithms.SHA256, data);
  return new Uint8Array(hash);
}
var RFC6962_LEAF_HASH_PREFIX, RFC6962_NODE_HASH_PREFIX;
var init_merkle = __esm({
  "node_modules/@freedomofpress/sigstore-browser/dist/tlog/merkle.js"() {
    init_dist();
    init_interfaces2();
    RFC6962_LEAF_HASH_PREFIX = new Uint8Array([0]);
    RFC6962_NODE_HASH_PREFIX = new Uint8Array([1]);
  }
});

// node_modules/@freedomofpress/sigstore-browser/dist/tlog/checkpoint.js
async function verifyCheckpoint(entry, tlogs) {
  if (!entry.inclusionProof?.checkpoint) {
    throw new Error("Missing checkpoint in inclusion proof");
  }
  const entryLogId = base64ToUint8Array(entry.logId.keyId);
  const matchingTLogs = tlogs.filter((tlog) => {
    const tlogId = base64ToUint8Array(tlog.logId.keyId);
    return uint8ArrayEqual(tlogId, entryLogId);
  });
  const validTLogs = entry.integratedTime ? filterTLogsByDate(matchingTLogs, new Date(Number(entry.integratedTime) * 1e3)) : matchingTLogs;
  const inclusionProof = entry.inclusionProof;
  const signedNote = SignedNote.fromString(inclusionProof.checkpoint.envelope);
  const checkpoint = LogCheckpoint.fromString(signedNote.note);
  if (!await verifySignedNote(signedNote, validTLogs)) {
    throw new Error("Invalid checkpoint signature");
  }
  const rootHash = base64ToUint8Array(inclusionProof.rootHash);
  if (!uint8ArrayEqual(checkpoint.logHash, rootHash)) {
    throw new Error("Root hash mismatch between checkpoint and inclusion proof");
  }
}
async function verifySignedNote(signedNote, tlogs) {
  const data = stringToUint8Array(signedNote.note);
  let hasValidSignature = false;
  for (const signature of signedNote.signatures) {
    const tlog = tlogs.find((tlog2) => {
      const logId = base64ToUint8Array(tlog2.logId.keyId);
      return uint8ArrayEqual(logId.subarray(0, 4), signature.keyHint);
    });
    if (!tlog) {
      continue;
    }
    const publicKey = await importTLogKey(tlog);
    const verified = await verifySignature(publicKey, data, signature.signature, tlog.hashAlgorithm);
    if (verified) {
      hasValidSignature = true;
    }
  }
  return hasValidSignature;
}
function filterTLogsByDate(tlogs, targetDate) {
  return tlogs.filter((tlog) => {
    const start = new Date(tlog.publicKey.validFor.start);
    const end = tlog.publicKey.validFor.end ? new Date(tlog.publicKey.validFor.end) : null;
    return targetDate >= start && (!end || targetDate <= end);
  });
}
async function importTLogKey(tlog) {
  const keyDetails = tlog.publicKey.keyDetails;
  let keyType;
  let scheme;
  if (keyDetails === "ecdsa-sha2-nistp256") {
    keyType = KeyTypes.Ecdsa;
    scheme = "P256-SHA256";
  } else if (keyDetails.includes("ECDSA")) {
    keyType = KeyTypes.Ecdsa;
    scheme = keyDetails.replace("PKIX_ECDSA_", "").replace(/_/g, "-");
  } else if (keyDetails.includes("ED25519")) {
    keyType = KeyTypes.Ed25519;
    scheme = KeyTypes.Ed25519;
  } else if (keyDetails.includes("RSA")) {
    keyType = KeyTypes.RSA;
    scheme = keyDetails.replace("PKIX_RSA_", "").replace(/_/g, "-");
  } else {
    throw new Error(`Unsupported key type in keyDetails: ${keyDetails}`);
  }
  return importKey(keyType, scheme, tlog.publicKey.rawBytes);
}
var CHECKPOINT_SEPARATOR, SIGNATURE_REGEX, SignedNote, LogCheckpoint;
var init_checkpoint = __esm({
  "node_modules/@freedomofpress/sigstore-browser/dist/tlog/checkpoint.js"() {
    init_dist();
    CHECKPOINT_SEPARATOR = "\n\n";
    SIGNATURE_REGEX = /\u2014 (\S+) (\S+)\n/g;
    SignedNote = class _SignedNote {
      constructor(note, signatures) {
        this.note = note;
        this.signatures = signatures;
      }
      static fromString(envelope) {
        if (!envelope.includes(CHECKPOINT_SEPARATOR)) {
          throw new Error("Missing checkpoint separator");
        }
        const split2 = envelope.indexOf(CHECKPOINT_SEPARATOR);
        const header = envelope.slice(0, split2 + 1);
        const data = envelope.slice(split2 + CHECKPOINT_SEPARATOR.length);
        const matches = data.matchAll(SIGNATURE_REGEX);
        const signatures = [];
        for (const match of matches) {
          const [, name, signature] = match;
          const sigBytes = base64ToUint8Array(signature);
          if (sigBytes.length < 5) {
            throw new Error("Malformed checkpoint signature");
          }
          signatures.push({
            name,
            keyHint: sigBytes.subarray(0, 4),
            signature: sigBytes.subarray(4)
          });
        }
        if (signatures.length === 0) {
          throw new Error("No signatures found in checkpoint");
        }
        return new _SignedNote(header, signatures);
      }
    };
    LogCheckpoint = class _LogCheckpoint {
      constructor(origin, logSize, logHash, rest) {
        this.origin = origin;
        this.logSize = logSize;
        this.logHash = logHash;
        this.rest = rest;
      }
      static fromString(note) {
        const lines = note.trimEnd().split("\n");
        if (lines.length < 3) {
          throw new Error("Too few lines in checkpoint header");
        }
        const origin = lines[0];
        const logSize = BigInt(lines[1]);
        const rootHash = base64ToUint8Array(lines[2]);
        const rest = lines.slice(3);
        return new _LogCheckpoint(origin, logSize, rootHash, rest);
      }
    };
  }
});

// node_modules/@freedomofpress/sigstore-browser/dist/tlog/hashedrekord.js
async function verifyHashedRekordBody(entry, bundle) {
  const hashedRekordEntry = entry;
  switch (hashedRekordEntry.apiVersion) {
    case "0.0.1":
      return verifyHashedRekordV001Body(hashedRekordEntry, bundle);
    case "0.0.2":
      return verifyHashedRekordV002Body(hashedRekordEntry, bundle);
    default:
      throw new Error(`Unsupported hashedrekord version: ${hashedRekordEntry.apiVersion}`);
  }
}
function verifyHashedRekordV001Body(entry, bundle) {
  const spec = entry.spec;
  if (!bundle.messageSignature) {
    throw new Error("Bundle missing messageSignature for hashedrekord entry");
  }
  const tlogSig = spec.signature.content || "";
  const tlogSigBytes = base64ToUint8Array(tlogSig);
  const bundleSigBytes = base64ToUint8Array(bundle.messageSignature.signature);
  if (!uint8ArrayEqual(tlogSigBytes, bundleSigBytes)) {
    throw new Error("Signature mismatch between TLog entry and bundle");
  }
  const tlogDigest = spec.data.hash?.value || "";
  const tlogDigestBytes = hexToUint8Array(tlogDigest);
  const bundleDigestBytes = base64ToUint8Array(bundle.messageSignature.messageDigest.digest);
  if (!uint8ArrayEqual(tlogDigestBytes, bundleDigestBytes)) {
    throw new Error("Digest mismatch between TLog entry and bundle");
  }
}
function verifyHashedRekordV002Body(entry, bundle) {
  const spec = entry.spec.hashedRekordV002;
  if (!bundle.messageSignature) {
    throw new Error("Bundle missing messageSignature for hashedrekord v0.0.2 entry");
  }
  const tlogSig = spec.signature.content || "";
  const tlogSigBytes = base64ToUint8Array(tlogSig);
  const bundleSigBytes = base64ToUint8Array(bundle.messageSignature.signature);
  if (!uint8ArrayEqual(tlogSigBytes, bundleSigBytes)) {
    throw new Error("Signature mismatch between TLog entry and bundle (v0.0.2)");
  }
  const tlogDigest = spec.data.digest || "";
  const tlogDigestBytes = base64ToUint8Array(tlogDigest);
  const bundleDigestBytes = base64ToUint8Array(bundle.messageSignature.messageDigest.digest);
  if (!uint8ArrayEqual(tlogDigestBytes, bundleDigestBytes)) {
    throw new Error("Digest mismatch between TLog entry and bundle (v0.0.2)");
  }
}
var init_hashedrekord = __esm({
  "node_modules/@freedomofpress/sigstore-browser/dist/tlog/hashedrekord.js"() {
    init_dist();
  }
});

// node_modules/@freedomofpress/sigstore-browser/dist/tlog/dsse.js
async function verifyDSSEBody(entry, bundle) {
  const dsseEntry = entry;
  switch (dsseEntry.apiVersion) {
    case "0.0.1":
      return verifyDSSE001Body(dsseEntry, bundle);
    case "0.0.2":
      return verifyDSSE002Body(dsseEntry, bundle);
    default:
      throw new Error(`Unsupported dsse version: ${dsseEntry.apiVersion}`);
  }
}
async function verifyDSSE001Body(entry, bundle) {
  if (!bundle.dsseEnvelope) {
    throw new Error("Bundle missing dsseEnvelope for DSSE entry");
  }
  if (!entry.spec.signatures || entry.spec.signatures.length !== 1) {
    throw new Error("DSSE entry must have exactly one signature");
  }
  const tlogSig = entry.spec.signatures[0].signature;
  const tlogSigBytes = base64ToUint8Array(tlogSig);
  if (bundle.dsseEnvelope.signatures.length === 0) {
    throw new Error("Bundle DSSE envelope missing signatures");
  }
  const bundleSigBytes = base64ToUint8Array(bundle.dsseEnvelope.signatures[0].sig);
  if (!uint8ArrayEqual(tlogSigBytes, bundleSigBytes)) {
    throw new Error("DSSE signature mismatch between TLog entry and bundle");
  }
  if (!entry.spec.payloadHash?.value || !entry.spec.payloadHash?.algorithm) {
    throw new Error("DSSE entry missing payloadHash or algorithm");
  }
  const hashAlg = getHashAlgorithm(entry.spec.payloadHash.algorithm);
  const tlogHashBytes = hexToUint8Array(entry.spec.payloadHash.value);
  const payloadBytes = base64ToUint8Array(bundle.dsseEnvelope.payload);
  const bundleHashBytes = new Uint8Array(await crypto.subtle.digest(hashAlg, payloadBytes));
  if (!uint8ArrayEqual(tlogHashBytes, bundleHashBytes)) {
    throw new Error("DSSE payload hash mismatch between TLog entry and bundle");
  }
}
async function verifyDSSE002Body(entry, bundle) {
  if (!bundle.dsseEnvelope) {
    throw new Error("Bundle missing dsseEnvelope for DSSE v0.0.2 entry");
  }
  const spec = entry.spec.dsseV002;
  if (!spec) {
    throw new Error("DSSE v0.0.2 entry missing dsseV002 spec");
  }
  if (!spec.signatures || spec.signatures.length !== 1) {
    throw new Error("DSSE v0.0.2 entry must have exactly one signature");
  }
  const tlogSig = spec.signatures[0].content;
  const tlogSigBytes = base64ToUint8Array(tlogSig);
  if (bundle.dsseEnvelope.signatures.length === 0) {
    throw new Error("Bundle DSSE envelope missing signatures");
  }
  const bundleSigBytes = base64ToUint8Array(bundle.dsseEnvelope.signatures[0].sig);
  if (!uint8ArrayEqual(tlogSigBytes, bundleSigBytes)) {
    throw new Error("DSSE signature mismatch between TLog entry and bundle (v0.0.2)");
  }
  if (!spec.payloadHash?.digest || !spec.payloadHash?.algorithm) {
    throw new Error("DSSE v0.0.2 entry missing payloadHash or algorithm");
  }
  const hashAlg = getHashAlgorithm(spec.payloadHash.algorithm);
  const tlogHashBytes = base64ToUint8Array(spec.payloadHash.digest);
  const payloadBytes = base64ToUint8Array(bundle.dsseEnvelope.payload);
  const bundleHashBytes = new Uint8Array(await crypto.subtle.digest(hashAlg, payloadBytes));
  if (!uint8ArrayEqual(tlogHashBytes, bundleHashBytes)) {
    throw new Error("DSSE payload hash mismatch between TLog entry and bundle (v0.0.2)");
  }
}
var init_dsse2 = __esm({
  "node_modules/@freedomofpress/sigstore-browser/dist/tlog/dsse.js"() {
    init_dist();
    init_interfaces2();
  }
});

// node_modules/@freedomofpress/sigstore-browser/dist/tlog/intoto.js
async function verifyIntotoBody(entry, bundle) {
  const intotoEntry = entry;
  if (intotoEntry.apiVersion !== "0.0.2") {
    throw new Error(`Unsupported intoto version: ${intotoEntry.apiVersion}`);
  }
  if (!bundle.dsseEnvelope) {
    throw new Error("Bundle missing dsseEnvelope for intoto entry");
  }
  const tlogEnvelope = intotoEntry.spec.content.envelope;
  if (!tlogEnvelope.signatures || tlogEnvelope.signatures.length !== 1) {
    throw new Error("Intoto entry must have exactly one signature");
  }
  const tlogSigBase64 = tlogEnvelope.signatures[0].sig;
  const tlogSigDecoded = base64Decode(tlogSigBase64);
  const tlogSigBytes = base64ToUint8Array(tlogSigDecoded);
  if (bundle.dsseEnvelope.signatures.length === 0) {
    throw new Error("Bundle DSSE envelope missing signatures");
  }
  const bundleSigBytes = base64ToUint8Array(bundle.dsseEnvelope.signatures[0].sig);
  if (!uint8ArrayEqual(tlogSigBytes, bundleSigBytes)) {
    throw new Error("Intoto signature mismatch between TLog entry and bundle");
  }
  if (intotoEntry.spec.content.payloadHash) {
    if (!intotoEntry.spec.content.payloadHash.algorithm) {
      throw new Error("Intoto entry missing payloadHash algorithm");
    }
    const hashAlg = getHashAlgorithm(intotoEntry.spec.content.payloadHash.algorithm);
    const tlogHashBytes = hexToUint8Array(intotoEntry.spec.content.payloadHash.value);
    const payloadBytes = base64ToUint8Array(bundle.dsseEnvelope.payload);
    const bundleHashBytes = new Uint8Array(await crypto.subtle.digest(hashAlg, payloadBytes));
    if (!uint8ArrayEqual(tlogHashBytes, bundleHashBytes)) {
      throw new Error("Intoto payload hash mismatch between TLog entry and bundle");
    }
  }
}
var init_intoto = __esm({
  "node_modules/@freedomofpress/sigstore-browser/dist/tlog/intoto.js"() {
    init_dist();
    init_interfaces2();
  }
});

// node_modules/@freedomofpress/sigstore-browser/dist/tlog/body.js
async function verifyTLogBody(entry, bundle) {
  const rekorEntry = parseCanonicalBody(entry);
  const { kind, version } = entry.kindVersion;
  if (kind !== rekorEntry.kind || version !== rekorEntry.apiVersion) {
    throw new Error(`kind/version mismatch - expected: ${kind}/${version}, received: ${rekorEntry.kind}/${rekorEntry.apiVersion}`);
  }
  switch (rekorEntry.kind) {
    case "hashedrekord":
      return verifyHashedRekordBody(rekorEntry, bundle);
    case "dsse":
      return verifyDSSEBody(rekorEntry, bundle);
    case "intoto":
      return verifyIntotoBody(rekorEntry, bundle);
    default:
      throw new Error(`Unsupported TLog entry kind: ${rekorEntry.kind}`);
  }
}
function parseCanonicalBody(entry) {
  try {
    const decodedBody = base64Decode(entry.canonicalizedBody);
    const rekorEntry = JSON.parse(decodedBody);
    if (!rekorEntry.apiVersion || !rekorEntry.kind || !rekorEntry.spec) {
      throw new Error("Invalid Rekor entry structure");
    }
    return rekorEntry;
  } catch (error) {
    throw new Error(`Failed to parse canonicalized body: ${error instanceof Error ? error.message : String(error)}`);
  }
}
var init_body = __esm({
  "node_modules/@freedomofpress/sigstore-browser/dist/tlog/body.js"() {
    init_dist();
    init_hashedrekord();
    init_dsse2();
    init_intoto();
  }
});

// node_modules/@freedomofpress/sigstore-browser/dist/rfc3161/error.js
var RFC3161TimestampVerificationError;
var init_error2 = __esm({
  "node_modules/@freedomofpress/sigstore-browser/dist/rfc3161/error.js"() {
    RFC3161TimestampVerificationError = class extends Error {
    };
  }
});

// node_modules/@freedomofpress/sigstore-browser/dist/rfc3161/tstinfo.js
var TSTInfo;
var init_tstinfo = __esm({
  "node_modules/@freedomofpress/sigstore-browser/dist/rfc3161/tstinfo.js"() {
    init_dist();
    init_interfaces2();
    init_oid();
    init_error2();
    TSTInfo = class {
      constructor(asn1) {
        this.root = asn1;
      }
      get version() {
        return this.root.subs[0].toInteger();
      }
      get genTime() {
        return this.root.subs[4].toDate();
      }
      get messageImprintHashAlgorithm() {
        const oid2 = this.messageImprintObj.subs[0].subs[0].toOID();
        const algo = SHA2_HASH_ALGOS[oid2];
        if (!algo) {
          throw new Error(`Unknown message imprint hash algorithm OID: ${oid2}`);
        }
        return algo;
      }
      get messageImprintHashedMessage() {
        return this.messageImprintObj.subs[1].value;
      }
      get raw() {
        return this.root.toDER();
      }
      async verify(data) {
        const hashAlg = this.messageImprintHashAlgorithm;
        const hashAlgName = hashAlg === "sha256" ? HashAlgorithms.SHA256 : hashAlg === "sha384" ? HashAlgorithms.SHA384 : hashAlg === "sha512" ? HashAlgorithms.SHA512 : hashAlg;
        const digest = await crypto.subtle.digest(hashAlgName, data);
        if (!uint8ArrayEqual(new Uint8Array(digest), this.messageImprintHashedMessage)) {
          throw new RFC3161TimestampVerificationError("message imprint does not match artifact");
        }
      }
      // https://www.rfc-editor.org/rfc/rfc3161#section-2.4.2
      get messageImprintObj() {
        return this.root.subs[2];
      }
    };
  }
});

// node_modules/@freedomofpress/sigstore-browser/dist/rfc3161/timestamp.js
var OID_PKCS9_CONTENT_TYPE_SIGNED_DATA, OID_PKCS9_CONTENT_TYPE_TSTINFO, OID_PKCS9_MESSAGE_DIGEST_KEY, RFC3161Timestamp;
var init_timestamp = __esm({
  "node_modules/@freedomofpress/sigstore-browser/dist/rfc3161/timestamp.js"() {
    init_dist();
    init_interfaces2();
    init_oid();
    init_error2();
    init_tstinfo();
    OID_PKCS9_CONTENT_TYPE_SIGNED_DATA = "1.2.840.113549.1.7.2";
    OID_PKCS9_CONTENT_TYPE_TSTINFO = "1.2.840.113549.1.9.16.1.4";
    OID_PKCS9_MESSAGE_DIGEST_KEY = "1.2.840.113549.1.9.4";
    RFC3161Timestamp = class _RFC3161Timestamp {
      constructor(asn1) {
        this.root = asn1;
      }
      static parse(der) {
        const asn1 = ASN1Obj.parseBuffer(der);
        return new _RFC3161Timestamp(asn1);
      }
      get status() {
        return this.pkiStatusInfoObj.subs[0].toInteger();
      }
      get contentType() {
        return this.contentTypeObj.toOID();
      }
      get eContentType() {
        return this.eContentTypeObj.toOID();
      }
      get signingTime() {
        return this.tstInfo.genTime;
      }
      get signerIssuer() {
        return this.signerSidObj.subs[0].value;
      }
      get signerSerialNumber() {
        return this.signerSidObj.subs[1].value;
      }
      get signerDigestAlgorithm() {
        const oid2 = this.signerDigestAlgorithmObj.subs[0].toOID();
        const algo = SHA2_HASH_ALGOS[oid2];
        if (!algo) {
          throw new Error(`Unknown digest algorithm OID: ${oid2}`);
        }
        return algo;
      }
      get signatureAlgorithm() {
        const oid2 = this.signatureAlgorithmObj.subs[0].toOID();
        const algo = ECDSA_SIGNATURE_ALGOS[oid2] || RSA_SIGNATURE_ALGOS[oid2];
        return algo;
      }
      get signatureValue() {
        return this.signatureValueObj.value;
      }
      get tstInfo() {
        return new TSTInfo(this.eContentObj.subs[0].subs[0]);
      }
      async verify(data, publicKey) {
        if (!this.timeStampTokenObj) {
          throw new RFC3161TimestampVerificationError("timeStampToken is missing");
        }
        if (this.contentType !== OID_PKCS9_CONTENT_TYPE_SIGNED_DATA) {
          throw new RFC3161TimestampVerificationError(`incorrect content type: ${this.contentType}`);
        }
        if (this.eContentType !== OID_PKCS9_CONTENT_TYPE_TSTINFO) {
          throw new RFC3161TimestampVerificationError(`incorrect encapsulated content type: ${this.eContentType}`);
        }
        await this.tstInfo.verify(data);
        await this.verifyMessageDigest();
        await this.verifySignature(publicKey);
      }
      async verifyMessageDigest() {
        const hashAlg = this.signerDigestAlgorithm;
        const hashAlgName = hashAlg === "sha256" ? HashAlgorithms.SHA256 : hashAlg === "sha384" ? HashAlgorithms.SHA384 : hashAlg === "sha512" ? HashAlgorithms.SHA512 : hashAlg;
        const tstInfoDigest = await crypto.subtle.digest(hashAlgName, this.tstInfo.raw);
        const expectedDigest = this.messageDigestAttributeObj.subs[1].subs[0].value;
        if (!uint8ArrayEqual(new Uint8Array(tstInfoDigest), expectedDigest)) {
          throw new RFC3161TimestampVerificationError("signed data does not match tstInfo");
        }
      }
      async verifySignature(key) {
        const signedAttrs = this.signedAttrsObj.toDER();
        signedAttrs[0] = 49;
        const oid2 = this.signatureAlgorithmObj.subs[0].toOID();
        const algo = ECDSA_SIGNATURE_ALGOS[oid2] || RSA_SIGNATURE_ALGOS[oid2];
        if (!algo) {
          throw new RFC3161TimestampVerificationError(`Unsupported signature algorithm OID: ${oid2}`);
        }
        const verified = await verifySignature(key, signedAttrs, this.signatureValue, algo);
        if (!verified) {
          throw new RFC3161TimestampVerificationError("signature verification failed");
        }
      }
      // https://www.rfc-editor.org/rfc/rfc3161#section-2.4.2
      get pkiStatusInfoObj() {
        return this.root.subs[0];
      }
      // https://www.rfc-editor.org/rfc/rfc3161#section-2.4.2
      get timeStampTokenObj() {
        return this.root.subs[1];
      }
      // https://datatracker.ietf.org/doc/html/rfc5652#section-3
      get contentTypeObj() {
        return this.timeStampTokenObj.subs[0];
      }
      // https://www.rfc-editor.org/rfc/rfc5652#section-3
      get signedDataObj() {
        const obj2 = this.timeStampTokenObj.subs.find((sub) => sub.tag.isContextSpecific(0));
        if (!obj2) {
          throw new RFC3161TimestampVerificationError("Missing timeStampTokenObj sub.");
        }
        return obj2.subs[0];
      }
      // https://datatracker.ietf.org/doc/html/rfc5652#section-5.1
      get encapContentInfoObj() {
        return this.signedDataObj.subs[2];
      }
      // https://datatracker.ietf.org/doc/html/rfc5652#section-5.1
      get signerInfosObj() {
        const sd = this.signedDataObj;
        return sd.subs[sd.subs.length - 1];
      }
      // https://www.rfc-editor.org/rfc/rfc5652#section-5.1
      get signerInfoObj() {
        return this.signerInfosObj.subs[0];
      }
      // https://datatracker.ietf.org/doc/html/rfc5652#section-5.2
      get eContentTypeObj() {
        return this.encapContentInfoObj.subs[0];
      }
      // https://datatracker.ietf.org/doc/html/rfc5652#section-5.2
      get eContentObj() {
        return this.encapContentInfoObj.subs[1];
      }
      // https://datatracker.ietf.org/doc/html/rfc5652#section-5.3
      get signedAttrsObj() {
        const signedAttrs = this.signerInfoObj.subs.find((sub) => sub.tag.isContextSpecific(0));
        if (!signedAttrs) {
          throw new RFC3161TimestampVerificationError("Missing signedAttrsObj.");
        }
        return signedAttrs;
      }
      // https://datatracker.ietf.org/doc/html/rfc5652#section-5.3
      get messageDigestAttributeObj() {
        const messageDigest = this.signedAttrsObj.subs.find((sub) => sub.subs[0].tag.isOID() && sub.subs[0].toOID() === OID_PKCS9_MESSAGE_DIGEST_KEY);
        if (!messageDigest) {
          throw new RFC3161TimestampVerificationError("Missing messageDigest.");
        }
        return messageDigest;
      }
      // https://datatracker.ietf.org/doc/html/rfc5652#section-5.3
      get signerSidObj() {
        return this.signerInfoObj.subs[1];
      }
      // https://datatracker.ietf.org/doc/html/rfc5652#section-5.3
      get signerDigestAlgorithmObj() {
        return this.signerInfoObj.subs[2];
      }
      // https://datatracker.ietf.org/doc/html/rfc5652#section-5.3
      get signatureAlgorithmObj() {
        return this.signerInfoObj.subs[4];
      }
      // https://datatracker.ietf.org/doc/html/rfc5652#section-5.3
      get signatureValueObj() {
        return this.signerInfoObj.subs[5];
      }
    };
  }
});

// node_modules/@freedomofpress/sigstore-browser/dist/rfc3161/index.js
var init_rfc3161 = __esm({
  "node_modules/@freedomofpress/sigstore-browser/dist/rfc3161/index.js"() {
    init_timestamp();
  }
});

// node_modules/@freedomofpress/sigstore-browser/dist/timestamp/tsa.js
async function verifyRFC3161Timestamp(timestamp, data, timestampAuthorities) {
  const signingTime = timestamp.signingTime;
  let validAuthorities = filterCertAuthorities(timestampAuthorities, signingTime);
  validAuthorities = filterCAsBySerialAndIssuer(validAuthorities, {
    serialNumber: timestamp.signerSerialNumber,
    issuer: timestamp.signerIssuer
  });
  const verificationResults = await Promise.allSettled(validAuthorities.map((ca) => verifyTimestampForCA(timestamp, data, ca)));
  const verified = verificationResults.some((result) => result.status === "fulfilled");
  if (!verified) {
    const errors = verificationResults.filter((r) => r.status === "rejected").map((r) => r.reason?.message || "Unknown error");
    throw new Error(`Timestamp could not be verified against any trusted authority. Errors: ${errors.join(", ")}`);
  }
  return signingTime;
}
function filterCertAuthorities(authorities, validAt) {
  return authorities.filter((ca) => {
    if (ca.validFor) {
      const start = ca.validFor.start ? new Date(ca.validFor.start) : null;
      const end = ca.validFor.end ? new Date(ca.validFor.end) : null;
      if (start && validAt < start) {
        return false;
      }
      if (end && validAt > end) {
        return false;
      }
    }
    return true;
  });
}
function filterCAsBySerialAndIssuer(timestampAuthorities, criteria) {
  return timestampAuthorities.filter((ca) => {
    if (!ca.certChain || ca.certChain.certificates.length === 0) {
      return false;
    }
    const leafCert = X509Certificate4.parse(base64ToUint8Array(ca.certChain.certificates[0].rawBytes));
    return uint8ArrayEqual(leafCert.serialNumber, criteria.serialNumber) && uint8ArrayEqual(leafCert.issuer, criteria.issuer);
  });
}
async function verifyTimestampForCA(timestamp, data, ca) {
  if (!ca.certChain || ca.certChain.certificates.length === 0) {
    throw new Error("Certificate authority missing certificate chain");
  }
  const leafCert = X509Certificate4.parse(base64ToUint8Array(ca.certChain.certificates[0].rawBytes));
  const signingTime = timestamp.signingTime;
  const trustedCerts = ca.certChain.certificates.slice(1).map((cert) => X509Certificate4.parse(base64ToUint8Array(cert.rawBytes)));
  try {
    const verifier = new CertificateChainVerifier({
      untrustedCert: leafCert,
      trustedCerts,
      timestamp: signingTime
    });
    await verifier.verify();
  } catch (e) {
    throw new Error(`TSA certificate chain verification failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const publicKey = await leafCert.publicKeyObj;
  await timestamp.verify(data, publicKey);
}
async function verifyBundleTimestamp(timestampData, signature, timestampAuthorities) {
  if (!timestampData?.rfc3161Timestamps?.length) {
    return [];
  }
  const verifiedResults = [];
  for (const tsData of timestampData.rfc3161Timestamps) {
    const timestampBytes = base64ToUint8Array(tsData.signedTimestamp);
    const timestamp = RFC3161Timestamp.parse(timestampBytes);
    const signingTime = await verifyRFC3161Timestamp(timestamp, signature, timestampAuthorities);
    verifiedResults.push({
      signingTime,
      signerSerialNumber: Array.from(timestamp.signerSerialNumber).join(",")
    });
  }
  for (let i = 0; i < verifiedResults.length; i++) {
    for (let j = i + 1; j < verifiedResults.length; j++) {
      if (verifiedResults[i].signingTime.getTime() === verifiedResults[j].signingTime.getTime() && verifiedResults[i].signerSerialNumber === verifiedResults[j].signerSerialNumber) {
        throw new Error("Duplicate TSA timestamp detected");
      }
    }
  }
  return verifiedResults.map((r) => r.signingTime);
}
var init_tsa = __esm({
  "node_modules/@freedomofpress/sigstore-browser/dist/timestamp/tsa.js"() {
    init_dist();
    init_x509();
    init_rfc3161();
  }
});

// node_modules/@freedomofpress/tuf-browser/dist/crypto.js
function getRoleKeys(keys, keyids) {
  const roleKeys = new Map(keys);
  for (const key of keys.keys()) {
    if (!keyids.includes(key)) {
      roleKeys.delete(key);
    }
  }
  return roleKeys;
}
async function loadKeys(keys) {
  const importedKeys = /* @__PURE__ */ new Map();
  for (const keyId in keys) {
    const key = keys[keyId];
    const canonicalBytes = stringToUint8Array(canonicalize(key));
    const verified_keyId = Uint8ArrayToHex(new Uint8Array(await crypto.subtle.digest(HashAlgorithms.SHA256, canonicalBytes)));
    if (importedKeys.has(verified_keyId)) {
      throw new Error("Duplicate keyId found!");
    }
    if (verified_keyId !== keyId) {
      console.warn(`KeyId ${keyId} does not match the expected ${verified_keyId}, importing anyway the provided one for proper referencing.`);
    }
    importedKeys.set(keyId, await importKey(key.keytype, key.scheme, key.keyval.public));
  }
  return importedKeys;
}
async function checkSignatures(keys, roleKeys, signed, signatures, threshold) {
  if (threshold < 1) {
    throw new Error("Threshold must be at least 1");
  }
  if (threshold > keys.size) {
    throw new Error("Threshold is bigger than the number of keys provided, something is wrong.");
  }
  const keyIds = new Set(roleKeys);
  const signed_canon = canonicalize(signed);
  let valid_signatures = 0;
  for (const signature of signatures) {
    if (!keyIds.has(signature.keyid)) {
      continue;
    }
    keyIds.delete(signature.keyid);
    const key = keys.get(signature.keyid);
    const sig = hexToUint8Array(signature.sig);
    if (!key) {
      throw new Error("Keyid was empty.");
    }
    if (await verifySignature(key, stringToUint8Array(signed_canon), sig) === true) {
      valid_signatures++;
    }
  }
  if (valid_signatures >= threshold) {
    return true;
  } else {
    return false;
  }
}
var init_crypto2 = __esm({
  "node_modules/@freedomofpress/tuf-browser/dist/crypto.js"() {
    init_dist();
  }
});

// node_modules/@freedomofpress/tuf-browser/dist/storage/encoding.js
function isRawBytesWrapper(value) {
  return value != null && typeof value === "object" && "__raw_bytes__" in value && // eslint-disable-next-line
  typeof value.__raw_bytes__ === "string";
}
function decodeRawBytesWrapper(wrapper) {
  const bytes2 = base64ToUint8Array(wrapper.__raw_bytes__);
  return JSON.parse(new TextDecoder().decode(bytes2));
}
function createRawBytesWrapper(value) {
  return { __raw_bytes__: Uint8ArrayToBase64(value) };
}
var init_encoding2 = __esm({
  "node_modules/@freedomofpress/tuf-browser/dist/storage/encoding.js"() {
    init_dist();
  }
});

// node_modules/@freedomofpress/tuf-browser/dist/storage/browser.js
var ExtensionStorageBackend;
var init_browser = __esm({
  "node_modules/@freedomofpress/tuf-browser/dist/storage/browser.js"() {
    init_encoding2();
    ExtensionStorageBackend = class {
      async read(key) {
        const result = await browser.storage.local.get(key);
        const value = result[key];
        if (isRawBytesWrapper(value)) {
          return decodeRawBytesWrapper(value);
        }
        return value;
      }
      async write(key, value) {
        await browser.storage.local.set({ [key]: value });
      }
      async writeRaw(key, value) {
        await browser.storage.local.set({ [key]: createRawBytesWrapper(value) });
      }
      async delete(key) {
        await browser.storage.local.remove(key);
      }
    };
  }
});

// node_modules/@freedomofpress/tuf-browser/dist/storage/localstorage.js
var LocalStorageBackend;
var init_localstorage = __esm({
  "node_modules/@freedomofpress/tuf-browser/dist/storage/localstorage.js"() {
    init_encoding2();
    LocalStorageBackend = class {
      async read(key) {
        const value = localStorage.getItem(key);
        if (value) {
          const parsed2 = JSON.parse(value);
          if (isRawBytesWrapper(parsed2)) {
            return decodeRawBytesWrapper(parsed2);
          }
          return parsed2;
        }
      }
      async write(key, value) {
        localStorage.setItem(key, JSON.stringify(value));
      }
      async writeRaw(key, value) {
        localStorage.setItem(key, JSON.stringify(createRawBytesWrapper(value)));
      }
      async delete(key) {
        localStorage.removeItem(key);
      }
    };
  }
});

// node_modules/@freedomofpress/tuf-browser/dist/storage/memory.js
var MemoryBackend;
var init_memory = __esm({
  "node_modules/@freedomofpress/tuf-browser/dist/storage/memory.js"() {
    init_encoding2();
    MemoryBackend = class {
      constructor() {
        this.cache = /* @__PURE__ */ new Map();
      }
      async read(key) {
        const value = this.cache.get(key);
        if (!value)
          return void 0;
        if (isRawBytesWrapper(value)) {
          return decodeRawBytesWrapper(value);
        }
        return value;
      }
      async write(key, value) {
        this.cache.set(key, value);
      }
      async writeRaw(key, value) {
        this.cache.set(key, createRawBytesWrapper(value));
      }
      async delete(key) {
        this.cache.delete(key);
      }
    };
  }
});

// node_modules/@freedomofpress/tuf-browser/dist/types.js
var Roles, TOP_LEVEL_ROLE_NAMES;
var init_types = __esm({
  "node_modules/@freedomofpress/tuf-browser/dist/types.js"() {
    init_dist();
    (function(Roles2) {
      Roles2["Root"] = "root";
      Roles2["Timestamp"] = "timestamp";
      Roles2["Snapshot"] = "snapshot";
      Roles2["Targets"] = "targets";
    })(Roles || (Roles = {}));
    TOP_LEVEL_ROLE_NAMES = [
      Roles.Root,
      Roles.Targets,
      Roles.Snapshot,
      Roles.Timestamp
    ];
  }
});

// node_modules/@freedomofpress/tuf-browser/dist/tuf.js
var tuf_exports = {};
__export(tuf_exports, {
  TUFClient: () => TUFClient
});
var TUFClient;
var init_tuf = __esm({
  "node_modules/@freedomofpress/tuf-browser/dist/tuf.js"() {
    init_dist();
    init_crypto2();
    init_browser();
    init_localstorage();
    init_memory();
    init_types();
    TUFClient = class {
      constructor(repositoryUrl, startingRoot, namespace, targetBaseUrl, options) {
        this.repositoryUrl = repositoryUrl;
        this.targetBaseUrl = targetBaseUrl || repositoryUrl;
        this.startingRoot = startingRoot;
        this.namespace = namespace;
        if (options?.backend) {
          this.backend = options.backend;
        } else if (options?.disableCache) {
          this.backend = new MemoryBackend();
        } else if (typeof browser !== "undefined" && browser.storage?.local) {
          this.backend = new ExtensionStorageBackend();
        } else if (typeof localStorage !== "undefined") {
          this.backend = new LocalStorageBackend();
        } else {
          this.backend = new MemoryBackend();
        }
      }
      getCacheKey(key) {
        if (key.startsWith("/") || key.startsWith("./") || key.includes("..") || key.includes("\\")) {
          throw new Error(`key contains an invalid pattern (${key})`);
        }
        return `${this.namespace}/${key}.json`;
      }
      async getFromCache(key) {
        const namespacedKey = this.getCacheKey(key);
        return await this.backend.read(namespacedKey);
      }
      async setInCache(key, value) {
        const namespacedKey = this.getCacheKey(key);
        await this.backend.write(namespacedKey, value);
      }
      async fetchMetafileBase(role, version, target = false) {
        let url;
        role = encodeURIComponent(role);
        if (!target) {
          url = version !== -1 ? `${this.repositoryUrl}${version}.${role}.json` : `${this.repositoryUrl}${role}.json`;
        } else {
          url = `${this.repositoryUrl}${version}.${role}`;
        }
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`Failed to fetch file: ${response.status} ${response.statusText}`);
        }
        return response;
      }
      validateMetadata(metadata) {
        const seenKeyIds = /* @__PURE__ */ new Set();
        for (const sig of metadata.signatures) {
          if (seenKeyIds.has(sig.keyid)) {
            throw new Error(`Duplicate signature found for keyid: ${sig.keyid}`);
          }
          seenKeyIds.add(sig.keyid);
        }
        const specVersion = metadata.signed.spec_version;
        if (!specVersion) {
          throw new Error("spec_version is required");
        }
        const parts = specVersion.split(".");
        if (parts.length < 2 || parts.length > 3) {
          throw new Error(`Invalid spec_version format: ${specVersion}`);
        }
        if (!parts.every((p) => /^\d+$/.test(p))) {
          throw new Error(`spec_version parts must be numeric: ${specVersion}`);
        }
        if (parts[0] !== "1") {
          throw new Error(`Unsupported spec_version major version: ${parts[0]} (expected 1)`);
        }
      }
      async fetchMetafileJson(role, version = -1) {
        const response = await this.fetchMetafileBase(role, version);
        const metadata = await response.json();
        this.validateMetadata(metadata);
        return metadata;
      }
      async fetchMetafileBinary(role, version = -1, target = false) {
        const response = await this.fetchMetafileBase(role, version, target);
        return new Uint8Array(await response.arrayBuffer());
      }
      bootstrapRoot(file) {
        try {
          const metadata = JSON.parse(file);
          this.validateMetadata(metadata);
          return metadata;
        } catch (error) {
          throw new Error(`Failed to load the JSON file:  ${error}`);
        }
      }
      async verifyHashes(data, hashes, context) {
        if (!hashes)
          return;
        const hashAlgoMap = {
          sha256: HashAlgorithms.SHA256,
          sha384: HashAlgorithms.SHA384,
          sha512: HashAlgorithms.SHA512
        };
        for (const [algo, expectedHash] of Object.entries(hashes)) {
          const cryptoAlgo = hashAlgoMap[algo];
          if (!cryptoAlgo) {
            throw new Error(`${context}: unsupported hash algorithm '${algo}'`);
          }
          const computedHash = Uint8ArrayToHex(new Uint8Array(await crypto.subtle.digest(cryptoAlgo, data)));
          if (expectedHash !== computedHash) {
            throw new Error(`${context}: ${algo} hash mismatch`);
          }
        }
      }
      // This function supports ECDSA (256, 385, 521), Ed25519 in Hex or PEM format
      // it is possible to support certain cases of RSA, but it is not really useful for now
      // Returns a mapping keyid (hexstring) -> CryptoKey object
      async loadRoot(json, oldroot) {
        if (json.signed._type !== Roles.Root) {
          throw new Error("Loading the wrong metafile as root.");
        }
        let keys;
        let threshold;
        let roleKeys;
        if (oldroot == void 0) {
          keys = await loadKeys(json.signed.keys);
          roleKeys = json.signed.roles.root.keyids;
          threshold = json.signed.roles.root.threshold;
        } else {
          keys = oldroot.keys;
          roleKeys = oldroot.roles["root"].keyids;
          threshold = oldroot.threshold;
        }
        if (await checkSignatures(keys, roleKeys, json.signed, json.signatures, threshold) !== true) {
          throw new Error("Failed to verify metafile.");
        }
        keys = await loadKeys(json.signed.keys);
        if (!Number.isSafeInteger(json.signed.version) || json.signed.version < 1) {
          throw new Error("There is something wrong with the root version number.");
        }
        for (const role of TOP_LEVEL_ROLE_NAMES) {
          if (!json.signed.roles[role]) {
            throw new Error(`Missing required top-level role: ${role}`);
          }
        }
        for (const [roleName, role] of Object.entries(json.signed.roles)) {
          const keyidSet = new Set(role.keyids);
          if (keyidSet.size !== role.keyids.length) {
            throw new Error(`Duplicate key IDs found in role: ${roleName}`);
          }
        }
        return {
          keys,
          version: json.signed.version,
          expires: new Date(json.signed.expires),
          threshold: json.signed.roles.root.threshold,
          consistent_snapshot: json.signed.consistent_snapshot,
          roles: json.signed.roles
        };
      }
      async updateRoot(frozenTimestamp) {
        let rootJson = await this.getFromCache(Roles.Root);
        if (!rootJson) {
          rootJson = await this.bootstrapRoot(this.startingRoot);
        }
        let root = await this.loadRoot(rootJson);
        const oldRoot = root;
        let newroot;
        let newrootJson;
        for (let new_version = root.version + 1; new_version < Number.MAX_SAFE_INTEGER; new_version++) {
          try {
            newrootJson = await this.fetchMetafileJson(Roles.Root, new_version);
          } catch (e) {
            if (e instanceof Error && e.message.includes("Failed to fetch")) {
              break;
            }
            throw e;
          }
          if (newrootJson.signed.version !== new_version) {
            throw new Error(`Version mismatch: URL version ${new_version} but file contains version ${newrootJson.signed.version}`);
          }
          if (newrootJson.signed?._type !== Roles.Root) {
            throw new Error("Incorrect metadata type for root.");
          }
          newroot = await this.loadRoot(newrootJson, root);
          if (newroot.version !== root.version + 1) {
            throw new Error(`Root version must be exactly ${root.version + 1}, got ${newroot.version}. Probable rollback attack.`);
          }
          newroot = await this.loadRoot(newrootJson);
          root = newroot;
          await this.setInCache(Roles.Root, newrootJson);
        }
        if (root.expires <= frozenTimestamp) {
          throw new Error("Freeze attack on the root metafile.");
        }
        if (root.version > oldRoot.version) {
          const timestampKeysChanged = JSON.stringify(root.roles.timestamp.keyids.sort()) !== JSON.stringify(oldRoot.roles.timestamp.keyids.sort());
          const snapshotKeysChanged = JSON.stringify(root.roles.snapshot.keyids.sort()) !== JSON.stringify(oldRoot.roles.snapshot.keyids.sort());
          const targetsKeysChanged = JSON.stringify(root.roles.targets.keyids.sort()) !== JSON.stringify(oldRoot.roles.targets.keyids.sort());
          if (timestampKeysChanged) {
            await this.backend.delete(this.getCacheKey(Roles.Timestamp));
            await this.backend.delete(this.getCacheKey(Roles.Snapshot));
            await this.backend.delete(this.getCacheKey(Roles.Targets));
          }
          if (snapshotKeysChanged) {
            await this.backend.delete(this.getCacheKey(Roles.Snapshot));
            await this.backend.delete(this.getCacheKey(Roles.Targets));
          }
          if (targetsKeysChanged) {
            await this.backend.delete(this.getCacheKey(Roles.Targets));
          }
        }
        return root;
      }
      async updateTimestamp(root, frozenTimestamp) {
        const keys = getRoleKeys(root.keys, root.roles.timestamp.keyids);
        if (keys.size < 1) {
          throw new Error("No valid keys found for the timestamp role.");
        }
        const cachedTimestamp = await this.getFromCache(Roles.Timestamp);
        const newTimestampRaw = await this.fetchMetafileBinary(Roles.Timestamp, -1);
        const newTimestamp = JSON.parse(Uint8ArrayToString(newTimestampRaw));
        this.validateMetadata(newTimestamp);
        if (newTimestamp.signed._type !== Roles.Timestamp) {
          throw new Error(`Invalid metadata type: expected ${Roles.Timestamp}, got ${newTimestamp.signed._type}`);
        }
        if (!newTimestamp.signed.meta || !newTimestamp.signed.meta["snapshot.json"]) {
          throw new Error("Timestamp metadata missing required meta['snapshot.json']");
        }
        if (await checkSignatures(keys, root.roles["timestamp"].keyids, newTimestamp.signed, newTimestamp.signatures, root.roles.timestamp.threshold) !== true) {
          throw new Error("Failed verifying timestamp role signature(s).");
        }
        if (cachedTimestamp !== void 0) {
          if (newTimestamp.signed.version < cachedTimestamp.signed.version) {
            throw new Error("New timestamp file has a lower version that the currently cached one.");
          }
          if (newTimestamp.signed.version == cachedTimestamp.signed.version) {
            return null;
          }
          if (newTimestamp.signed.meta["snapshot.json"].version < cachedTimestamp.signed.meta["snapshot.json"].version) {
            throw new Error("Timestamp has been updated, but snapshot version has been rolled back.");
          }
        }
        if (new Date(newTimestamp.signed.expires) <= frozenTimestamp) {
          throw new Error("Freeze attack on the timestamp metafile.");
        }
        await this.backend.writeRaw(this.getCacheKey(Roles.Timestamp), newTimestampRaw);
        return newTimestamp;
      }
      async updateSnapshot(root, frozenTimestamp, timestampMeta) {
        const version = timestampMeta.signed.meta["snapshot.json"].version;
        const keys = getRoleKeys(root.keys, root.roles.snapshot.keyids);
        const cachedSnapshot = await this.getFromCache(Roles.Snapshot);
        let newSnapshotRaw;
        if (root.consistent_snapshot) {
          newSnapshotRaw = await this.fetchMetafileBinary(Roles.Snapshot, version);
        } else {
          newSnapshotRaw = await this.fetchMetafileBinary(Roles.Snapshot, -1);
        }
        const snapshotMeta = timestampMeta.signed.meta["snapshot.json"];
        if (snapshotMeta.length !== void 0) {
          if (newSnapshotRaw.length !== snapshotMeta.length) {
            throw new Error(`Snapshot length mismatch: expected ${snapshotMeta.length}, got ${newSnapshotRaw.length}`);
          }
        }
        await this.verifyHashes(newSnapshotRaw, snapshotMeta.hashes, "Snapshot");
        const newSnapshot = JSON.parse(Uint8ArrayToString(newSnapshotRaw));
        this.validateMetadata(newSnapshot);
        if (newSnapshot.signed._type !== Roles.Snapshot) {
          throw new Error(`Invalid metadata type: expected ${Roles.Snapshot}, got ${newSnapshot.signed._type}`);
        }
        if (!newSnapshot.signed.meta || !newSnapshot.signed.meta["targets.json"]) {
          throw new Error("Snapshot metadata missing required meta['targets.json']");
        }
        if (await checkSignatures(keys, root.roles["snapshot"].keyids, newSnapshot.signed, newSnapshot.signatures, root.roles.snapshot.threshold) !== true) {
          throw new Error("Failed verifying snapshot role signature(s).");
        }
        if (newSnapshot.signed.version !== version) {
          throw new Error(`Snapshot version mismatch: URL version ${version} but file contains version ${newSnapshot.signed.version}`);
        }
        if (cachedSnapshot !== void 0) {
          for (const [target] of Object.entries(cachedSnapshot.signed.meta)) {
            if (target in newSnapshot.signed.meta !== true) {
              throw new Error("Target that was listed in an older snapshot was dropped in a newer one.");
            }
            if (newSnapshot.signed.meta[target].version < cachedSnapshot.signed.meta[target].version) {
              throw new Error("Target version in newer snapshot is lower than the cached one. Probable rollback attack.");
            }
          }
        }
        if (new Date(newSnapshot.signed.expires) <= frozenTimestamp) {
          throw new Error("Freeze attack on the snapshot metafile.");
        }
        await this.backend.writeRaw(this.getCacheKey(Roles.Snapshot), newSnapshotRaw);
        return newSnapshot.signed.meta;
      }
      async updateTargets(root, frozenTimestamp, snapshot) {
        const keys = getRoleKeys(root.keys, root.roles.targets.keyids);
        const cachedTargets = await this.getFromCache(Roles.Targets);
        let newTargetsRaw;
        if (root.consistent_snapshot) {
          newTargetsRaw = await this.fetchMetafileBinary(Roles.Targets, snapshot[`${Roles.Targets}.json`].version);
        } else {
          newTargetsRaw = await this.fetchMetafileBinary(Roles.Targets, -1);
        }
        const targetsMeta = snapshot[`${Roles.Targets}.json`];
        if (targetsMeta.length !== void 0) {
          if (newTargetsRaw.length !== targetsMeta.length) {
            throw new Error(`Targets length mismatch: expected ${targetsMeta.length}, got ${newTargetsRaw.length}`);
          }
        }
        await this.verifyHashes(newTargetsRaw, targetsMeta.hashes, "Targets");
        const newTargets = JSON.parse(Uint8ArrayToString(newTargetsRaw));
        this.validateMetadata(newTargets);
        if (newTargets.signed._type !== Roles.Targets) {
          throw new Error(`Invalid metadata type: expected ${Roles.Targets}, got ${newTargets.signed._type}`);
        }
        if (await checkSignatures(keys, root.roles["targets"].keyids, newTargets.signed, newTargets.signatures, root.roles.targets.threshold) !== true) {
          throw new Error(`Failed verifying targets role.`);
        }
        const expectedVersion = snapshot[`${Roles.Targets}.json`].version;
        if (newTargets.signed.version !== expectedVersion) {
          throw new Error(`Targets version mismatch: URL version ${expectedVersion} but file contains version ${newTargets.signed.version}`);
        }
        if (cachedTargets !== void 0 && newTargets.signed.version < cachedTargets.signed.version) {
          throw new Error("Targets version is lower than the cached one. Probable rollback attack.");
        }
        if (new Date(newTargets.signed.expires) <= frozenTimestamp) {
          throw new Error("Freeze attack on the targets metafile.");
        }
        await this.backend.writeRaw(this.getCacheKey(Roles.Targets), newTargetsRaw);
      }
      async listSignedTargets() {
        const cachedTargets = await this.getFromCache(Roles.Targets);
        const filenames = [];
        if (cachedTargets) {
          for (const filename of Object.keys(cachedTargets.signed.targets)) {
            filenames.push(filename);
          }
        }
        return filenames;
      }
      async fetchTarget(name) {
        const cachedTargets = await this.getFromCache(Roles.Targets);
        if (cachedTargets === void 0) {
          throw new Error("Failed to find the targets metafile when it should have existed.");
        }
        if (!(name in cachedTargets.signed.targets)) {
          throw new Error(`${name} not present in the targets role.`);
        }
        const targetInfo = cachedTargets.signed.targets[name];
        const targetHashes = targetInfo.hashes;
        let hashForUrl;
        if (targetHashes.sha256) {
          hashForUrl = targetHashes.sha256;
        } else if (targetHashes.sha512) {
          hashForUrl = targetHashes.sha512;
        } else {
          throw new Error(`No supported hash algorithm found for ${name}. Available: ${Object.keys(targetHashes).join(", ")}`);
        }
        const lastSlash = name.lastIndexOf("/");
        const targetUrl = lastSlash === -1 ? `${this.targetBaseUrl}${hashForUrl}.${name}` : `${this.targetBaseUrl}${name.substring(0, lastSlash + 1)}${hashForUrl}.${name.substring(lastSlash + 1)}`;
        const response = await fetch(targetUrl);
        if (!response.ok) {
          throw new Error(`Failed to fetch target: ${response.status} ${response.statusText}`);
        }
        const raw_file = new Uint8Array(await response.arrayBuffer());
        if (raw_file.byteLength !== targetInfo.length) {
          throw new Error(`${name} length mismatch: expected ${targetInfo.length}, got ${raw_file.byteLength}`);
        }
        await this.verifyHashes(raw_file, targetHashes, `Target '${name}'`);
        return raw_file.buffer;
      }
      async updateTUF() {
        const frozenTimestamp = /* @__PURE__ */ new Date();
        const root = await this.updateRoot(frozenTimestamp);
        const timestampMeta = await this.updateTimestamp(root, frozenTimestamp);
        if (timestampMeta === null) {
          return;
        }
        const snapshot = await this.updateSnapshot(root, frozenTimestamp, timestampMeta);
        await this.updateTargets(root, frozenTimestamp, snapshot);
      }
      async getTarget(name) {
        return await this.fetchTarget(name);
      }
    };
  }
});

// node_modules/@freedomofpress/sigstore-browser/dist/trust/tuf-root.js
var tuf_root_exports = {};
__export(tuf_root_exports, {
  default: () => tuf_root_default
});
var tuf_root_default;
var init_tuf_root = __esm({
  "node_modules/@freedomofpress/sigstore-browser/dist/trust/tuf-root.js"() {
    tuf_root_default = "ewogInNpZ25hdHVyZXMiOiBbCiAgewogICAia2V5aWQiOiAiNmYyNjAwODlkNTkyM2RhZjIwMTY2Y2E2NTdjNTQzYWY2MTgzNDZhYjk3MTg4NGE5OTk2MmIwMTk4OGJiZTBjMyIsCiAgICJzaWciOiAiIgogIH0sCiAgewogICAia2V5aWQiOiAiZTcxYTU0ZDU0MzgzNWJhODZhZGFkOTQ2MDM3OWM3NjQxZmI4NzI2ZDE2NGVhNzY2ODAxYTFjNTIyYWJhN2VhMiIsCiAgICJzaWciOiAiMzA0NTAyMjEwMGJiZGRkNDY0ZjgwNjZjZWI4OGJhNzg3Mzc1YzEyY2Q2MzMwNjgwZTA4YzI5MTA3MDNlNjUzOGM3MWNjNzlhZDIwMjIwNTE5MGIwNmU0NTM3ZmU5NjFiM2VmODFmZTY4ZWRjZDAwODljMTlmOTE5YWZlZDQyM2I5YWFmZDcwMDY0MTE1MyIKICB9LAogIHsKICAgImtleWlkIjogIjIyZjRjYWVjNmQ4ZTZmOTU1NWFmNjZiM2Q0YzNjYjA2YTNiYjIzZmRjN2UzOWM5MTZjNjFmNDYyZTZmNTJiMDYiLAogICAic2lnIjogIjMwNDQwMjIwNjkzMDZjZDUyNTdmNzMyYTc0MGMxYWZlNjBhOGU0MzNjNWRlNThlYWZlYWRiZTk5YzMzNmM5YzcxZDE5OGNmODAyMjAwZDc3Mzk1M2FlN2RiYzQ4ZDNlNWJhZDlhNmY2NGJhZmZmMTk2YjdlMmFkNGE1MmExOTUxOTM2N2Q0N2RjMDQyIgogIH0sCiAgewogICAia2V5aWQiOiAiNjE2NDM4MzgxMjViNDQwYjQwZGI2OTQyZjVjYjVhMzFjMGRjMDQzNjgzMTZlYjJhYWE1OGI5NTkwNGE1ODIyMiIsCiAgICJzaWciOiAiMzA0NDAyMjA0ZDIxYTJlYzgwZGY2NmU2MWY2ZmUyOTEyOTUxZGM0N2RmODM2MDM2ZjhjMGFiMTA4MTZkMzc1ZTcxZGJmNzllMDIyMDU0N2FkY2UxYWZkZjA0ZTY3OTRlZmEyMDNkZDUyNjRjNmY3ZTBlZjc4ZTU3ZmU5MzRiMGQyNmNiOTk0ZWVjNzYiCiAgfSwKICB7CiAgICJrZXlpZCI6ICJhNjg3ZTViZjRmYWI4MmIwZWU1OGQ0NmUwNWM5NTM1MTQ1YTJjOWFmYjQ1OGY0M2Q0MmI0NWNhMGZkY2UyYTcwIiwKICAgInNpZyI6ICIzMDQ1MDIyMDYwODI2NDk2NTU3MTQ0ZWIxNjQ5ODkzZWQ1ZjZmNGVhNTQ1MzZmZWIwY2E4MmY4Yjg5YWU2NDFiZTM5NzQzZTUwMjIxMDBhZDcxMThiNWU5ZDQ4MzczMjYyMDZlNDEyZmM2ZGEyOTk5OTI1ZDExMDMyOGE3YzE2NmIwNmM2MjQzMzZjOTNmIgogIH0sCiAgewogICAia2V5aWQiOiAiMTgzZTY0ZjM3NjcwZGMxM2NhMGQyODk5NWEzMDUzZjM3NDA5NTRkZGNlNDQzMjFhNDFlNDY1MzRjZjQ0ZTYzMiIsCiAgICJzaWciOiAiMzA0NjAyMjEwMGQ4MTc5NDM5YzJlNzNlYjBjMTczM2FiZWU3ZmFmODMyZGNhZWE3MjYzZWRjYjQ5MTk4OTFjM2EyNDdmMDU5MjMwMjIxMDBlMWE0MzdlMDc5N2U4MDNmOWI3MmRjOWQyZDkyMTU1YjBhMjI3MGMyNGVmZGQ1ZjRiM2E1ZDhmMGIwZjQzMWE3IgogIH0KIF0sCiAic2lnbmVkIjogewogICJfdHlwZSI6ICJyb290IiwKICAiY29uc2lzdGVudF9zbmFwc2hvdCI6IHRydWUsCiAgImV4cGlyZXMiOiAiMjAyNi0wMS0yMlQxMzowNTo1OVoiLAogICJrZXlzIjogewogICAiMGM4NzQzMmMzYmYwOWZkOTkxODlmZGMzMmZhNWVhZWRmNGU0YTVmYWM3YmFiNzNmYTA0YTJlMGZjNjRhZjZmNSI6IHsKICAgICJrZXlpZF9oYXNoX2FsZ29yaXRobXMiOiBbCiAgICAgInNoYTI1NiIsCiAgICAgInNoYTUxMiIKICAgIF0sCiAgICAia2V5dHlwZSI6ICJlY2RzYSIsCiAgICAia2V5dmFsIjogewogICAgICJwdWJsaWMiOiAiLS0tLS1CRUdJTiBQVUJMSUMgS0VZLS0tLS1cbk1Ga3dFd1lIS29aSXpqMENBUVlJS29aSXpqMERBUWNEUWdBRVdSaUdyNStqKzNKNVNzSCtadHI1bkUySDJ3TzdcbkJWK25PM3M5M2dMY2ExOHFUT3pIWTFvV3lBR0R5a01Tc0dUVUJTdDlEK0FuMEtmS3NEMm1mU000MlE9PVxuLS0tLS1FTkQgUFVCTElDIEtFWS0tLS0tXG4iCiAgICB9LAogICAgInNjaGVtZSI6ICJlY2RzYS1zaGEyLW5pc3RwMjU2IiwKICAgICJ4LXR1Zi1vbi1jaS1vbmxpbmUtdXJpIjogImdjcGttczpwcm9qZWN0cy9zaWdzdG9yZS1yb290LXNpZ25pbmcvbG9jYXRpb25zL2dsb2JhbC9rZXlSaW5ncy9yb290L2NyeXB0b0tleXMvdGltZXN0YW1wL2NyeXB0b0tleVZlcnNpb25zLzEiCiAgIH0sCiAgICIxODNlNjRmMzc2NzBkYzEzY2EwZDI4OTk1YTMwNTNmMzc0MDk1NGRkY2U0NDMyMWE0MWU0NjUzNGNmNDRlNjMyIjogewogICAgImtleXR5cGUiOiAiZWNkc2EiLAogICAgImtleXZhbCI6IHsKICAgICAicHVibGljIjogIi0tLS0tQkVHSU4gUFVCTElDIEtFWS0tLS0tXG5NRmt3RXdZSEtvWkl6ajBDQVFZSUtvWkl6ajBEQVFjRFFnQUVNeHBQT0pDSVo1b3RHNDEwNmZHSnNlRVFpM1Y5XG5wa01ZUTR1eVY5VGoxTTdXSFhJeUxHK2prZnZ1RzBnbFExSlpiUlpaQlYzZ0FSNHNvamRHSElTZW93PT1cbi0tLS0tRU5EIFBVQkxJQyBLRVktLS0tLVxuIgogICAgfSwKICAgICJzY2hlbWUiOiAiZWNkc2Etc2hhMi1uaXN0cDI1NiIsCiAgICAieC10dWYtb24tY2kta2V5b3duZXIiOiAiQGxhbmNlIgogICB9LAogICAiMjJmNGNhZWM2ZDhlNmY5NTU1YWY2NmIzZDRjM2NiMDZhM2JiMjNmZGM3ZTM5YzkxNmM2MWY0NjJlNmY1MmIwNiI6IHsKICAgICJrZXlpZF9oYXNoX2FsZ29yaXRobXMiOiBbCiAgICAgInNoYTI1NiIsCiAgICAgInNoYTUxMiIKICAgIF0sCiAgICAia2V5dHlwZSI6ICJlY2RzYSIsCiAgICAia2V5dmFsIjogewogICAgICJwdWJsaWMiOiAiLS0tLS1CRUdJTiBQVUJMSUMgS0VZLS0tLS1cbk1Ga3dFd1lIS29aSXpqMENBUVlJS29aSXpqMERBUWNEUWdBRXpCelZPbUhDUG9qTVZMU0kzNjRXaWlWOE5QckRcbjZJZ1J4Vmxpc2t6L3YreTNKRVI1bWNWR2NPTmxpRGNXTUM1SjJsZkhtalBOUGhiNEg3eG04THpmU0E9PVxuLS0tLS1FTkQgUFVCTElDIEtFWS0tLS0tXG4iCiAgICB9LAogICAgInNjaGVtZSI6ICJlY2RzYS1zaGEyLW5pc3RwMjU2IiwKICAgICJ4LXR1Zi1vbi1jaS1rZXlvd25lciI6ICJAc2FudGlhZ290b3JyZXMiCiAgIH0sCiAgICI2MTY0MzgzODEyNWI0NDBiNDBkYjY5NDJmNWNiNWEzMWMwZGMwNDM2ODMxNmViMmFhYTU4Yjk1OTA0YTU4MjIyIjogewogICAgImtleWlkX2hhc2hfYWxnb3JpdGhtcyI6IFsKICAgICAic2hhMjU2IiwKICAgICAic2hhNTEyIgogICAgXSwKICAgICJrZXl0eXBlIjogImVjZHNhIiwKICAgICJrZXl2YWwiOiB7CiAgICAgInB1YmxpYyI6ICItLS0tLUJFR0lOIFBVQkxJQyBLRVktLS0tLVxuTUZrd0V3WUhLb1pJemowQ0FRWUlLb1pJemowREFRY0RRZ0FFaW5pa1NzQVFtWWtOZUg1ZVlxL0NuSXpMYWFjT1xueGxTYWF3UURPd3FLeS90Q3F4cTV4eFBTSmMyMUs0V0loczlHeU9rS2Z6dWVZM0dJTHpjTUpaNGNXdz09XG4tLS0tLUVORCBQVUJMSUMgS0VZLS0tLS1cbiIKICAgIH0sCiAgICAic2NoZW1lIjogImVjZHNhLXNoYTItbmlzdHAyNTYiLAogICAgIngtdHVmLW9uLWNpLWtleW93bmVyIjogIkBib2JjYWxsYXdheSIKICAgfSwKICAgImE2ODdlNWJmNGZhYjgyYjBlZTU4ZDQ2ZTA1Yzk1MzUxNDVhMmM5YWZiNDU4ZjQzZDQyYjQ1Y2EwZmRjZTJhNzAiOiB7CiAgICAia2V5aWRfaGFzaF9hbGdvcml0aG1zIjogWwogICAgICJzaGEyNTYiLAogICAgICJzaGE1MTIiCiAgICBdLAogICAgImtleXR5cGUiOiAiZWNkc2EiLAogICAgImtleXZhbCI6IHsKICAgICAicHVibGljIjogIi0tLS0tQkVHSU4gUFVCTElDIEtFWS0tLS0tXG5NRmt3RXdZSEtvWkl6ajBDQVFZSUtvWkl6ajBEQVFjRFFnQUUwZ2hyaDkyTHcxWXIzaWRHVjVXcUN0TURCOEN4XG4rRDhoZEM0dzJaTE5JcGxWUm9WR0xza1lhM2doZU15T2ppSjhrUGkxNWFRMi8vN1Arb2o3VXZKUEd3PT1cbi0tLS0tRU5EIFBVQkxJQyBLRVktLS0tLVxuIgogICAgfSwKICAgICJzY2hlbWUiOiAiZWNkc2Etc2hhMi1uaXN0cDI1NiIsCiAgICAieC10dWYtb24tY2kta2V5b3duZXIiOiAiQGpvc2h1YWdsIgogICB9LAogICAiZTcxYTU0ZDU0MzgzNWJhODZhZGFkOTQ2MDM3OWM3NjQxZmI4NzI2ZDE2NGVhNzY2ODAxYTFjNTIyYWJhN2VhMiI6IHsKICAgICJrZXlpZF9oYXNoX2FsZ29yaXRobXMiOiBbCiAgICAgInNoYTI1NiIsCiAgICAgInNoYTUxMiIKICAgIF0sCiAgICAia2V5dHlwZSI6ICJlY2RzYSIsCiAgICAia2V5dmFsIjogewogICAgICJwdWJsaWMiOiAiLS0tLS1CRUdJTiBQVUJMSUMgS0VZLS0tLS1cbk1Ga3dFd1lIS29aSXpqMENBUVlJS29aSXpqMERBUWNEUWdBRUVYc3ozU1pYRmI4ak1WNDJqNnBKbHlqYmpSOEtcbk4zQndvY2V4cTZMTUliNXFzV0tPUXZMTjE2TlVlZkxjNEhzd09vdW1Sc1ZWYWFqU3BRUzZmb2JrUnc9PVxuLS0tLS1FTkQgUFVCTElDIEtFWS0tLS0tXG4iCiAgICB9LAogICAgInNjaGVtZSI6ICJlY2RzYS1zaGEyLW5pc3RwMjU2IiwKICAgICJ4LXR1Zi1vbi1jaS1rZXlvd25lciI6ICJAbW5tNjc4IgogICB9CiAgfSwKICAicm9sZXMiOiB7CiAgICJyb290IjogewogICAgImtleWlkcyI6IFsKICAgICAiZTcxYTU0ZDU0MzgzNWJhODZhZGFkOTQ2MDM3OWM3NjQxZmI4NzI2ZDE2NGVhNzY2ODAxYTFjNTIyYWJhN2VhMiIsCiAgICAgIjIyZjRjYWVjNmQ4ZTZmOTU1NWFmNjZiM2Q0YzNjYjA2YTNiYjIzZmRjN2UzOWM5MTZjNjFmNDYyZTZmNTJiMDYiLAogICAgICI2MTY0MzgzODEyNWI0NDBiNDBkYjY5NDJmNWNiNWEzMWMwZGMwNDM2ODMxNmViMmFhYTU4Yjk1OTA0YTU4MjIyIiwKICAgICAiYTY4N2U1YmY0ZmFiODJiMGVlNThkNDZlMDVjOTUzNTE0NWEyYzlhZmI0NThmNDNkNDJiNDVjYTBmZGNlMmE3MCIsCiAgICAgIjE4M2U2NGYzNzY3MGRjMTNjYTBkMjg5OTVhMzA1M2YzNzQwOTU0ZGRjZTQ0MzIxYTQxZTQ2NTM0Y2Y0NGU2MzIiCiAgICBdLAogICAgInRocmVzaG9sZCI6IDMKICAgfSwKICAgInNuYXBzaG90IjogewogICAgImtleWlkcyI6IFsKICAgICAiMGM4NzQzMmMzYmYwOWZkOTkxODlmZGMzMmZhNWVhZWRmNGU0YTVmYWM3YmFiNzNmYTA0YTJlMGZjNjRhZjZmNSIKICAgIF0sCiAgICAidGhyZXNob2xkIjogMSwKICAgICJ4LXR1Zi1vbi1jaS1leHBpcnktcGVyaW9kIjogMzY1MCwKICAgICJ4LXR1Zi1vbi1jaS1zaWduaW5nLXBlcmlvZCI6IDM2NQogICB9LAogICAidGFyZ2V0cyI6IHsKICAgICJrZXlpZHMiOiBbCiAgICAgImU3MWE1NGQ1NDM4MzViYTg2YWRhZDk0NjAzNzljNzY0MWZiODcyNmQxNjRlYTc2NjgwMWExYzUyMmFiYTdlYTIiLAogICAgICIyMmY0Y2FlYzZkOGU2Zjk1NTVhZjY2YjNkNGMzY2IwNmEzYmIyM2ZkYzdlMzljOTE2YzYxZjQ2MmU2ZjUyYjA2IiwKICAgICAiNjE2NDM4MzgxMjViNDQwYjQwZGI2OTQyZjVjYjVhMzFjMGRjMDQzNjgzMTZlYjJhYWE1OGI5NTkwNGE1ODIyMiIsCiAgICAgImE2ODdlNWJmNGZhYjgyYjBlZTU4ZDQ2ZTA1Yzk1MzUxNDVhMmM5YWZiNDU4ZjQzZDQyYjQ1Y2EwZmRjZTJhNzAiLAogICAgICIxODNlNjRmMzc2NzBkYzEzY2EwZDI4OTk1YTMwNTNmMzc0MDk1NGRkY2U0NDMyMWE0MWU0NjUzNGNmNDRlNjMyIgogICAgXSwKICAgICJ0aHJlc2hvbGQiOiAzCiAgIH0sCiAgICJ0aW1lc3RhbXAiOiB7CiAgICAia2V5aWRzIjogWwogICAgICIwYzg3NDMyYzNiZjA5ZmQ5OTE4OWZkYzMyZmE1ZWFlZGY0ZTRhNWZhYzdiYWI3M2ZhMDRhMmUwZmM2NGFmNmY1IgogICAgXSwKICAgICJ0aHJlc2hvbGQiOiAxLAogICAgIngtdHVmLW9uLWNpLWV4cGlyeS1wZXJpb2QiOiA3LAogICAgIngtdHVmLW9uLWNpLXNpZ25pbmctcGVyaW9kIjogNgogICB9CiAgfSwKICAic3BlY192ZXJzaW9uIjogIjEuMCIsCiAgInZlcnNpb24iOiAxMywKICAieC10dWYtb24tY2ktZXhwaXJ5LXBlcmlvZCI6IDE5NywKICAieC10dWYtb24tY2ktc2lnbmluZy1wZXJpb2QiOiA0NgogfQp9";
  }
});

// node_modules/@freedomofpress/sigstore-browser/dist/trust/tuf.js
var DEFAULT_CONFIG, TrustedRootProvider;
var init_tuf2 = __esm({
  "node_modules/@freedomofpress/sigstore-browser/dist/trust/tuf.js"() {
    init_dist();
    DEFAULT_CONFIG = {
      metadataUrl: "https://tuf-repo-cdn.sigstore.dev/",
      targetBaseUrl: "https://tuf-repo-cdn.sigstore.dev/targets/",
      namespace: "tuf-cache",
      trustedRootTarget: "trusted_root.json",
      cacheTTL: 36e5
      // 1 hour
    };
    TrustedRootProvider = class {
      constructor(options = {}) {
        const metadataUrl = options.metadataUrl || DEFAULT_CONFIG.metadataUrl;
        this.metadataUrl = metadataUrl.endsWith("/") ? metadataUrl : `${metadataUrl}/`;
        const targetBaseUrl = options.targetBaseUrl || DEFAULT_CONFIG.targetBaseUrl;
        this.targetBaseUrl = targetBaseUrl.endsWith("/") ? targetBaseUrl : `${targetBaseUrl}/`;
        this.initialRoot = options.initialRoot;
        this.namespace = options.namespace || DEFAULT_CONFIG.namespace;
        this.trustedRootTarget = options.trustedRootTarget || DEFAULT_CONFIG.trustedRootTarget;
        this.cacheTTL = options.cacheTTL ?? DEFAULT_CONFIG.cacheTTL;
        this.disableCache = options.disableCache ?? false;
      }
      /**
       * Initialize the TUF client
       * Lazy initialization to avoid loading TUF client until needed
       */
      async initTUFClient() {
        if (this.tufClient) {
          return;
        }
        try {
          const { TUFClient: TUFClient2 } = await Promise.resolve().then(() => (init_tuf(), tuf_exports));
          const rootMetadata = this.initialRoot || await this.getDefaultRoot();
          this.tufClient = new TUFClient2(this.metadataUrl, rootMetadata, this.namespace, this.targetBaseUrl, { disableCache: this.disableCache });
        } catch (error) {
          throw new Error(`Failed to initialize TUF client: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      /**
       * Get the default embedded root metadata
       * Returns the TUF root.json that bootstraps the TUF client
       */
      async getDefaultRoot() {
        const { default: tufRootBase64 } = await Promise.resolve().then(() => (init_tuf_root(), tuf_root_exports));
        const decoder = new TextDecoder();
        const rootBytes = Uint8Array.from(atob(tufRootBase64), (c) => c.charCodeAt(0));
        return decoder.decode(rootBytes);
      }
      /**
       * Check if cached trusted root is still valid
       */
      isCacheValid() {
        if (!this.cachedRoot || !this.cacheTimestamp) {
          return false;
        }
        const now = Date.now();
        return now - this.cacheTimestamp < this.cacheTTL;
      }
      /**
       * Get the Sigstore trusted root metadata
       * Uses TUF to securely fetch and verify the trusted root
       *
       * @returns Promise<TrustedRoot> The verified trusted root metadata
       * @throws Error if TUF verification fails or root cannot be fetched
       */
      async getTrustedRoot() {
        if (this.isCacheValid() && this.cachedRoot) {
          return this.cachedRoot;
        }
        await this.initTUFClient();
        if (!this.tufClient) {
          throw new Error("TUF client not initialized");
        }
        try {
          await this.tufClient.updateTUF();
          const trustedRootBuffer = await this.tufClient.getTarget(this.trustedRootTarget);
          const trustedRootJson = Uint8ArrayToString(new Uint8Array(trustedRootBuffer));
          const trustedRoot = JSON.parse(trustedRootJson);
          this.cachedRoot = trustedRoot;
          this.cacheTimestamp = Date.now();
          return trustedRoot;
        } catch (error) {
          throw new Error(`Failed to fetch trusted root via TUF: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      /**
       * Manually refresh the trusted root from TUF
       * Bypasses cache and forces a fresh fetch
       *
       * @returns Promise<TrustedRoot> The updated trusted root metadata
       */
      async refreshTrustedRoot() {
        this.cachedRoot = void 0;
        this.cacheTimestamp = void 0;
        return await this.getTrustedRoot();
      }
      /**
       * Clear the cached trusted root
       * Next call to getTrustedRoot() will fetch fresh data
       */
      clearCache() {
        this.cachedRoot = void 0;
        this.cacheTimestamp = void 0;
      }
    };
  }
});

// node_modules/@freedomofpress/sigstore-browser/dist/errors.js
var VerificationError, TimestampError, CertificateError, TLogError, SignatureError, PolicyError;
var init_errors = __esm({
  "node_modules/@freedomofpress/sigstore-browser/dist/errors.js"() {
    VerificationError = class _VerificationError extends Error {
      constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "VerificationError";
        Object.setPrototypeOf(this, _VerificationError.prototype);
      }
    };
    TimestampError = class _TimestampError extends VerificationError {
      constructor(message) {
        super("TIMESTAMP_ERROR", message);
        this.name = "TimestampError";
        Object.setPrototypeOf(this, _TimestampError.prototype);
      }
    };
    CertificateError = class _CertificateError extends VerificationError {
      constructor(message) {
        super("CERTIFICATE_ERROR", message);
        this.name = "CertificateError";
        Object.setPrototypeOf(this, _CertificateError.prototype);
      }
    };
    TLogError = class _TLogError extends VerificationError {
      constructor(message) {
        super("TLOG_ERROR", message);
        this.name = "TLogError";
        Object.setPrototypeOf(this, _TLogError.prototype);
      }
    };
    SignatureError = class _SignatureError extends VerificationError {
      constructor(message) {
        super("SIGNATURE_ERROR", message);
        this.name = "SignatureError";
        Object.setPrototypeOf(this, _SignatureError.prototype);
      }
    };
    PolicyError = class _PolicyError extends VerificationError {
      constructor(message) {
        super("POLICY_ERROR", message);
        this.name = "PolicyError";
        Object.setPrototypeOf(this, _PolicyError.prototype);
      }
    };
  }
});

// node_modules/@freedomofpress/sigstore-browser/dist/policy.js
var GITHUB_OIDC_ISSUER, SingleX509ExtPolicyV1, SingleX509ExtPolicyV2, OIDCIssuer, GitHubWorkflowTrigger, GitHubWorkflowSHA, GitHubWorkflowName, GitHubWorkflowRepository, GitHubWorkflowRef, OIDCIssuerV2, OIDCBuildSignerURI, OIDCBuildSignerDigest, OIDCRunnerEnvironment, OIDCSourceRepositoryURI, OIDCSourceRepositoryDigest, OIDCSourceRepositoryRef, OIDCSourceRepositoryIdentifier, OIDCSourceRepositoryOwnerURI, OIDCSourceRepositoryOwnerIdentifier, OIDCBuildConfigURI, OIDCBuildConfigDigest, OIDCBuildTrigger, OIDCRunInvocationURI, OIDCSourceRepositoryVisibility, AnyOf, AllOf, Identity;
var init_policy = __esm({
  "node_modules/@freedomofpress/sigstore-browser/dist/policy.js"() {
    init_errors();
    init_cert();
    GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
    SingleX509ExtPolicyV1 = class {
      constructor(value) {
        this.expectedValue = value;
      }
      verify(cert) {
        const extValue = this.getExtensionValue(cert);
        if (extValue === void 0) {
          throw new PolicyError(`Certificate does not contain ${this.name} (${this.oid}) extension`);
        }
        if (extValue !== this.expectedValue) {
          throw new PolicyError(`Certificate's ${this.name} does not match (got '${extValue}', expected '${this.expectedValue}')`);
        }
      }
    };
    SingleX509ExtPolicyV2 = class extends SingleX509ExtPolicyV1 {
    };
    OIDCIssuer = class extends SingleX509ExtPolicyV1 {
      constructor() {
        super(...arguments);
        this.oid = EXTENSION_OID_FULCIO_ISSUER_V1;
        this.name = "OIDCIssuer";
      }
      getExtensionValue(cert) {
        return cert.extFulcioIssuerV1?.issuer;
      }
    };
    GitHubWorkflowTrigger = class extends SingleX509ExtPolicyV1 {
      constructor() {
        super(...arguments);
        this.oid = EXTENSION_OID_GITHUB_WORKFLOW_TRIGGER;
        this.name = "GitHubWorkflowTrigger";
      }
      getExtensionValue(cert) {
        return cert.extGitHubWorkflowTrigger?.workflowTrigger;
      }
    };
    GitHubWorkflowSHA = class extends SingleX509ExtPolicyV1 {
      constructor() {
        super(...arguments);
        this.oid = EXTENSION_OID_GITHUB_WORKFLOW_SHA;
        this.name = "GitHubWorkflowSHA";
      }
      getExtensionValue(cert) {
        return cert.extGitHubWorkflowSHA?.workflowSHA;
      }
    };
    GitHubWorkflowName = class extends SingleX509ExtPolicyV1 {
      constructor() {
        super(...arguments);
        this.oid = EXTENSION_OID_GITHUB_WORKFLOW_NAME;
        this.name = "GitHubWorkflowName";
      }
      getExtensionValue(cert) {
        return cert.extGitHubWorkflowName?.workflowName;
      }
    };
    GitHubWorkflowRepository = class extends SingleX509ExtPolicyV1 {
      constructor() {
        super(...arguments);
        this.oid = EXTENSION_OID_GITHUB_WORKFLOW_REPOSITORY;
        this.name = "GitHubWorkflowRepository";
      }
      getExtensionValue(cert) {
        return cert.extGitHubWorkflowRepository?.workflowRepository;
      }
    };
    GitHubWorkflowRef = class extends SingleX509ExtPolicyV1 {
      constructor() {
        super(...arguments);
        this.oid = EXTENSION_OID_GITHUB_WORKFLOW_REF;
        this.name = "GitHubWorkflowRef";
      }
      getExtensionValue(cert) {
        return cert.extGitHubWorkflowRef?.workflowRef;
      }
    };
    OIDCIssuerV2 = class extends SingleX509ExtPolicyV2 {
      constructor() {
        super(...arguments);
        this.oid = EXTENSION_OID_FULCIO_ISSUER_V2;
        this.name = "OIDCIssuerV2";
      }
      getExtensionValue(cert) {
        return cert.extFulcioIssuerV2?.issuer;
      }
    };
    OIDCBuildSignerURI = class extends SingleX509ExtPolicyV2 {
      constructor() {
        super(...arguments);
        this.oid = EXTENSION_OID_BUILD_SIGNER_URI;
        this.name = "OIDCBuildSignerURI";
      }
      getExtensionValue(cert) {
        return cert.extBuildSignerURI?.buildSignerURI;
      }
    };
    OIDCBuildSignerDigest = class extends SingleX509ExtPolicyV2 {
      constructor() {
        super(...arguments);
        this.oid = EXTENSION_OID_BUILD_SIGNER_DIGEST;
        this.name = "OIDCBuildSignerDigest";
      }
      getExtensionValue(cert) {
        return cert.extBuildSignerDigest?.buildSignerDigest;
      }
    };
    OIDCRunnerEnvironment = class extends SingleX509ExtPolicyV2 {
      constructor() {
        super(...arguments);
        this.oid = EXTENSION_OID_RUNNER_ENVIRONMENT;
        this.name = "OIDCRunnerEnvironment";
      }
      getExtensionValue(cert) {
        return cert.extRunnerEnvironment?.runnerEnvironment;
      }
    };
    OIDCSourceRepositoryURI = class extends SingleX509ExtPolicyV2 {
      constructor() {
        super(...arguments);
        this.oid = EXTENSION_OID_SOURCE_REPOSITORY_URI;
        this.name = "OIDCSourceRepositoryURI";
      }
      getExtensionValue(cert) {
        return cert.extSourceRepositoryURI?.sourceRepositoryURI;
      }
    };
    OIDCSourceRepositoryDigest = class extends SingleX509ExtPolicyV2 {
      constructor() {
        super(...arguments);
        this.oid = EXTENSION_OID_SOURCE_REPOSITORY_DIGEST;
        this.name = "OIDCSourceRepositoryDigest";
      }
      getExtensionValue(cert) {
        return cert.extSourceRepositoryDigest?.sourceRepositoryDigest;
      }
    };
    OIDCSourceRepositoryRef = class extends SingleX509ExtPolicyV2 {
      constructor() {
        super(...arguments);
        this.oid = EXTENSION_OID_SOURCE_REPOSITORY_REF;
        this.name = "OIDCSourceRepositoryRef";
      }
      getExtensionValue(cert) {
        return cert.extSourceRepositoryRef?.sourceRepositoryRef;
      }
    };
    OIDCSourceRepositoryIdentifier = class extends SingleX509ExtPolicyV2 {
      constructor() {
        super(...arguments);
        this.oid = EXTENSION_OID_SOURCE_REPOSITORY_IDENTIFIER;
        this.name = "OIDCSourceRepositoryIdentifier";
      }
      getExtensionValue(cert) {
        return cert.extSourceRepositoryIdentifier?.sourceRepositoryIdentifier;
      }
    };
    OIDCSourceRepositoryOwnerURI = class extends SingleX509ExtPolicyV2 {
      constructor() {
        super(...arguments);
        this.oid = EXTENSION_OID_SOURCE_REPOSITORY_OWNER_URI;
        this.name = "OIDCSourceRepositoryOwnerURI";
      }
      getExtensionValue(cert) {
        return cert.extSourceRepositoryOwnerURI?.sourceRepositoryOwnerURI;
      }
    };
    OIDCSourceRepositoryOwnerIdentifier = class extends SingleX509ExtPolicyV2 {
      constructor() {
        super(...arguments);
        this.oid = EXTENSION_OID_SOURCE_REPOSITORY_OWNER_IDENTIFIER;
        this.name = "OIDCSourceRepositoryOwnerIdentifier";
      }
      getExtensionValue(cert) {
        return cert.extSourceRepositoryOwnerIdentifier?.sourceRepositoryOwnerIdentifier;
      }
    };
    OIDCBuildConfigURI = class extends SingleX509ExtPolicyV2 {
      constructor() {
        super(...arguments);
        this.oid = EXTENSION_OID_BUILD_CONFIG_URI;
        this.name = "OIDCBuildConfigURI";
      }
      getExtensionValue(cert) {
        return cert.extBuildConfigURI?.buildConfigURI;
      }
    };
    OIDCBuildConfigDigest = class extends SingleX509ExtPolicyV2 {
      constructor() {
        super(...arguments);
        this.oid = EXTENSION_OID_BUILD_CONFIG_DIGEST;
        this.name = "OIDCBuildConfigDigest";
      }
      getExtensionValue(cert) {
        return cert.extBuildConfigDigest?.buildConfigDigest;
      }
    };
    OIDCBuildTrigger = class extends SingleX509ExtPolicyV2 {
      constructor() {
        super(...arguments);
        this.oid = EXTENSION_OID_BUILD_TRIGGER;
        this.name = "OIDCBuildTrigger";
      }
      getExtensionValue(cert) {
        return cert.extBuildTrigger?.buildTrigger;
      }
    };
    OIDCRunInvocationURI = class extends SingleX509ExtPolicyV2 {
      constructor() {
        super(...arguments);
        this.oid = EXTENSION_OID_RUN_INVOCATION_URI;
        this.name = "OIDCRunInvocationURI";
      }
      getExtensionValue(cert) {
        return cert.extRunInvocationURI?.runInvocationURI;
      }
    };
    OIDCSourceRepositoryVisibility = class extends SingleX509ExtPolicyV2 {
      constructor() {
        super(...arguments);
        this.oid = EXTENSION_OID_SOURCE_REPOSITORY_VISIBILITY;
        this.name = "OIDCSourceRepositoryVisibility";
      }
      getExtensionValue(cert) {
        return cert.extSourceRepositoryVisibility?.sourceRepositoryVisibility;
      }
    };
    AnyOf = class {
      constructor(children2) {
        this.children = children2;
      }
      verify(cert) {
        for (const child of this.children) {
          try {
            child.verify(cert);
            return;
          } catch {
          }
        }
        throw new PolicyError(`0 of ${this.children.length} policies succeeded`);
      }
    };
    AllOf = class {
      constructor(children2) {
        this.children = children2;
      }
      verify(cert) {
        if (this.children.length < 1) {
          throw new PolicyError("no child policies to verify");
        }
        for (const child of this.children) {
          child.verify(cert);
        }
      }
    };
    Identity = class {
      constructor(options) {
        this.identity = options.identity;
        this.issuerPolicy = options.issuer ? new OIDCIssuer(options.issuer) : null;
      }
      verify(cert) {
        if (this.issuerPolicy) {
          this.issuerPolicy.verify(cert);
        }
        const sanExt = cert.extSubjectAltName;
        if (!sanExt) {
          throw new PolicyError("Certificate does not contain SubjectAlternativeName extension");
        }
        const allSans = /* @__PURE__ */ new Set();
        if (sanExt.rfc822Name) {
          allSans.add(sanExt.rfc822Name);
        }
        if (sanExt.uri) {
          allSans.add(sanExt.uri);
        }
        const otherName = sanExt.otherName(EXTENSION_OID_OTHERNAME);
        if (otherName) {
          allSans.add(otherName);
        }
        if (!allSans.has(this.identity)) {
          throw new PolicyError(`Certificate's SANs do not match ${this.identity}; actual SANs: ${Array.from(allSans).join(", ")}`);
        }
      }
    };
  }
});

// node_modules/@freedomofpress/sigstore-browser/dist/sigstore.js
function getBundleVersion(mediaType) {
  switch (mediaType) {
    case `${MEDIA_TYPE_BASE}+json;version=0.1`:
      return "0.1";
    case `${MEDIA_TYPE_BASE}+json;version=0.2`:
      return "0.2";
    case `${MEDIA_TYPE_BASE}+json;version=0.3`:
      return "0.3";
  }
  if (mediaType.startsWith(`${MEDIA_TYPE_BASE}.v`) && mediaType.endsWith("+json")) {
    const version = mediaType.replace(`${MEDIA_TYPE_BASE}.v`, "").replace("+json", "");
    if (/^\d+\.\d+(\.\d+)?$/.test(version)) {
      return version;
    }
  }
  return "0.1";
}
function assertRekorV2Timestamp(timestampData) {
  if (!timestampData?.rfc3161Timestamps?.length) {
    throw new Error("Rekor v2 bundles require a timestamp for verification.");
  }
}
var MEDIA_TYPE_BASE, SigstoreVerifier;
var init_sigstore = __esm({
  "node_modules/@freedomofpress/sigstore-browser/dist/sigstore.js"() {
    init_dist();
    init_interfaces2();
    init_x509();
    init_dsse();
    init_interfaces2();
    init_merkle();
    init_checkpoint();
    init_body();
    init_tsa();
    init_tuf2();
    init_policy();
    MEDIA_TYPE_BASE = "application/vnd.dev.sigstore.bundle";
    SigstoreVerifier = class {
      constructor(options = {}) {
        this.root = void 0;
        this.rawRoot = void 0;
        this.options = {
          tlogThreshold: options.tlogThreshold ?? 1,
          ctlogThreshold: options.ctlogThreshold ?? 1,
          tsaThreshold: options.tsaThreshold ?? 0
        };
      }
      async loadLog(frozenTimestamp, logs) {
        for (const log of logs) {
          if (frozenTimestamp > new Date(log.publicKey.validFor.start) && (!log.publicKey.validFor.end || new Date(log.publicKey.validFor.end) > frozenTimestamp)) {
            return {
              publicKey: await importKey(log.publicKey.keyDetails, log.publicKey.keyDetails, log.publicKey.rawBytes),
              logId: base64ToUint8Array(log.logId.keyId)
            };
          }
        }
        return void 0;
      }
      async loadCTLogs(frozenTimestamp, ctlogs) {
        const result = [];
        for (const log of ctlogs) {
          const start = new Date(log.publicKey.validFor.start);
          const end = log.publicKey.validFor.end ? new Date(log.publicKey.validFor.end) : /* @__PURE__ */ new Date("9999-12-31");
          if (start <= frozenTimestamp) {
            const publicKey = await importKey(log.publicKey.keyDetails, log.publicKey.keyDetails, log.publicKey.rawBytes);
            result.push({
              logID: base64ToUint8Array(log.logId.keyId),
              publicKey,
              validFor: { start, end }
            });
          }
        }
        if (result.length === 0) {
          throw new Error("Could not find any valid CT logs in sigstore root.");
        }
        return result;
      }
      // Adapted from https://github.com/sigstore/sigstore-js/blob/main/packages/verify/src/key/certificate.ts#L22-L53
      // Verifies that the leaf certificate chains to a trusted CA and is valid at the given timestamp.
      // Differences from sigstore-js:
      // - This is async (uses await) because our CertificateChainVerifier.verify() is async
      // - sigstore-js filters CAs using filterCertAuthorities() before calling this function,
      //   we do the timestamp filtering inline within this function
      async verifyCertificateChain(timestamp, leaf, certificateAuthorities) {
        let lastError;
        for (const ca of certificateAuthorities) {
          if (timestamp < ca.validFor.start || timestamp > ca.validFor.end) {
            continue;
          }
          try {
            const verifier = new CertificateChainVerifier({
              trustedCerts: ca.certChain,
              untrustedCert: leaf,
              timestamp
            });
            return await verifier.verify();
          } catch (err) {
            lastError = err;
          }
        }
        throw new Error(`Failed to verify certificate chain: ${lastError?.message || "No valid CAs found"}`);
      }
      // Load timestamp authorities that are valid at the frozen timestamp.
      // Unlike sigstore-js which doesn't pre-load TSAs (it passes raw TSA data to timestamp verification),
      // we parse and filter them at initialization time for consistency with how we handle CAs and other roots.
      loadTSA(frozenTimestamp, tsas) {
        if (!tsas || tsas.length === 0) {
          return [];
        }
        const result = [];
        for (const tsa of tsas) {
          const start = new Date(tsa.validFor.start);
          const end = tsa.validFor.end ? new Date(tsa.validFor.end) : /* @__PURE__ */ new Date(864e13);
          if (frozenTimestamp > start && frozenTimestamp < end) {
            const certChain = tsa.certChain.certificates.map((cert) => X509Certificate4.parse(base64ToUint8Array(cert.rawBytes)));
            if (certChain.length > 0) {
              result.push({
                certChain,
                validFor: { start, end }
              });
            }
          }
        }
        return result;
      }
      // Load certificate authorities (Fulcio CAs) that are valid at the frozen timestamp.
      // Similar to sigstore-js's filterCertAuthorities() in trust/filter.ts, but we also
      // parse the certificates at load time whereas sigstore-js keeps them in the trust material
      // and parses them during verification. This pre-loading approach is consistent with our
      // architecture of loading all trusted roots at initialization.
      loadCA(frozenTimestamp, cas) {
        const result = [];
        for (const ca of cas) {
          const start = new Date(ca.validFor.start);
          const end = ca.validFor.end ? new Date(ca.validFor.end) : /* @__PURE__ */ new Date(864e13);
          if (frozenTimestamp > start && frozenTimestamp < end) {
            const certChain = ca.certChain.certificates.map((cert) => X509Certificate4.parse(base64ToUint8Array(cert.rawBytes)));
            if (certChain.length > 0) {
              result.push({
                certChain,
                validFor: { start, end }
              });
            }
          }
        }
        return result;
      }
      async loadSigstoreRoot(rawRoot) {
        const frozenTimestamp = /* @__PURE__ */ new Date();
        this.rawRoot = rawRoot;
        this.root = {
          rekor: await this.loadLog(frozenTimestamp, rawRoot[SigstoreRoots.tlogs]),
          ctlogs: await this.loadCTLogs(frozenTimestamp, rawRoot[SigstoreRoots.ctlogs]),
          certificateAuthorities: this.loadCA(frozenTimestamp, rawRoot[SigstoreRoots.certificateAuthorities]),
          timestampAuthorities: this.loadTSA(frozenTimestamp, rawRoot.timestampAuthorities)
        };
      }
      /**
       * Load Sigstore trusted root via TUF
       * Uses The Update Framework for secure, verified updates of trusted root metadata
       *
       * @param tufProvider Optional TrustedRootProvider instance. If not provided, uses default Sigstore TUF repository
       */
      async loadSigstoreRootWithTUF(tufProvider) {
        const provider = tufProvider || new TrustedRootProvider();
        const trustedRoot = await provider.getTrustedRoot();
        await this.loadSigstoreRoot(trustedRoot);
      }
      // Adapted from https://github.com/sigstore/sigstore-js/blob/main/packages/verify/src/key/sct.ts
      // Key differences:
      // - Adds duplicate SCT detection (not in reference)
      // - Inline CT log filtering by logID and validity period (reference uses filterTLogAuthorities)
      // - Returns array of verified SCT logIDs for threshold checking (matches reference behavior)
      async verifySCT(cert, issuer, ctlogs) {
        let extSCT;
        const clone = cert.clone();
        for (let i = 0; i < clone.extensions.length; i++) {
          const ext2 = clone.extensions[i];
          if (ext2.subs[0].toOID() === EXTENSION_OID_SCT) {
            extSCT = new X509SCTExtension(ext2);
            clone.extensions.splice(i, 1);
            break;
          }
        }
        if (!extSCT) {
          throw new Error("Certificate is missing required SCT extension");
        }
        if (extSCT.signedCertificateTimestamps.length === 0) {
          throw new Error("SCT extension is present but contains no SCTs");
        }
        const seenLogIds = /* @__PURE__ */ new Set();
        for (const sct of extSCT.signedCertificateTimestamps) {
          const logIdHex = Uint8ArrayToHex(sct.logID);
          if (seenLogIds.has(logIdHex)) {
            throw new Error(`Duplicate SCT found for log ID: ${logIdHex}`);
          }
          seenLogIds.add(logIdHex);
        }
        const preCert = new ByteStream();
        const issuerId = new Uint8Array(await crypto.subtle.digest(HashAlgorithms.SHA256, issuer.publicKey));
        preCert.appendView(issuerId);
        const tbs = clone.tbsCertificate.toDER();
        preCert.appendUint24(tbs.length);
        preCert.appendView(tbs);
        const verifiedSCTs = [];
        for (const sct of extSCT.signedCertificateTimestamps) {
          const validCTLogs = ctlogs.filter((log) => {
            if (!uint8ArrayEqual(log.logID, sct.logID))
              return false;
            return log.validFor.start <= sct.datetime && sct.datetime <= log.validFor.end;
          });
          const verified = await (async () => {
            for (const log of validCTLogs) {
              try {
                if (await sct.verify(preCert.buffer, log.publicKey)) {
                  return true;
                }
              } catch {
              }
            }
            return false;
          })();
          if (!verified) {
            throw new Error("SCT verification failed");
          }
          verifiedSCTs.push(sct.logID);
        }
        return verifiedSCTs;
      }
      async verifyInclusionPromise(cert, bundle, rekor) {
        const entries = bundle.verificationMaterial.tlogEntries;
        if (entries.length < this.options.tlogThreshold) {
          throw new Error(`Not enough tlog entries: ${entries.length} < ${this.options.tlogThreshold}`);
        }
        const MAX_TLOG_ENTRIES = 32;
        if (entries.length > MAX_TLOG_ENTRIES) {
          throw new Error(`Too many tlog entries: ${entries.length} > ${MAX_TLOG_ENTRIES}`);
        }
        for (let i = 0; i < entries.length; i++) {
          for (let j = i + 1; j < entries.length; j++) {
            const iLogId = Uint8ArrayToHex(base64ToUint8Array(entries[i].logId.keyId));
            const jLogId = Uint8ArrayToHex(base64ToUint8Array(entries[j].logId.keyId));
            if (iLogId === jLogId && entries[i].logIndex === entries[j].logIndex) {
              throw new Error(`Duplicate tlog entry found: logID=${iLogId}, logIndex=${entries[i].logIndex}`);
            }
          }
        }
        const entry = entries[0];
        const bundleVersion = getBundleVersion(bundle.mediaType);
        const isV02OrLater = parseFloat(bundleVersion) >= 0.2;
        if (isV02OrLater && !entry.inclusionProof) {
          throw new Error("Bundle v0.2+ requires an inclusion proof.");
        }
        if (!entry.inclusionPromise?.signedEntryTimestamp) {
          if (!entry.inclusionProof) {
            throw new Error("Bundle must have either an inclusion promise or an inclusion proof.");
          }
        } else {
          if (!rekor && entry.inclusionProof) {
          } else {
            if (!rekor) {
              throw new Error("Rekor public key not found in trusted root");
            }
            const entryLogId = base64ToUint8Array(entry.logId.keyId);
            if (!uint8ArrayEqual(rekor.logId, entryLogId)) {
              throw new Error(`Rekor log ID mismatch: bundle uses ${Uint8ArrayToHex(entryLogId)} but loaded key is for ${Uint8ArrayToHex(rekor.logId)}`);
            }
            const signature = base64ToUint8Array(entry.inclusionPromise.signedEntryTimestamp);
            const keyId = Uint8ArrayToHex(entryLogId);
            const integratedTime = Number(entry.integratedTime);
            const signed = stringToUint8Array(canonicalize({
              body: entry.canonicalizedBody,
              integratedTime,
              logIndex: Number(entry.logIndex),
              logID: keyId
            }));
            if (!await verifySignature(rekor.publicKey, signed, signature)) {
              throw new Error("Failed to verify the inclusion promise in the provided bundle.");
            }
          }
        }
        if (entry.integratedTime) {
          const integratedTime = Number(entry.integratedTime);
          const integratedDate = new Date(integratedTime * 1e3);
          if (!cert.validForDate(integratedDate)) {
            throw new Error("Artifact signing was logged outside of the certificate validity.");
          }
        } else {
          assertRekorV2Timestamp(bundle.verificationMaterial.timestampVerificationData);
        }
        const bodyJson = JSON.parse(Uint8ArrayToString(base64ToUint8Array(entry.canonicalizedBody)));
        if (bodyJson.kind === "hashedrekord") {
          let loggedCertContent;
          if (bodyJson.spec.hashedRekordV002) {
            const verifier = bodyJson.spec.hashedRekordV002.signature.verifier;
            if (verifier?.x509Certificate) {
              loggedCertContent = verifier.x509Certificate.rawBytes;
            }
          } else if (bodyJson.spec.signature?.publicKey) {
            loggedCertContent = bodyJson.spec.signature.publicKey.content;
          }
          if (loggedCertContent) {
            let loggedCert;
            if (bodyJson.spec.hashedRekordV002) {
              loggedCert = X509Certificate4.parse(base64ToUint8Array(loggedCertContent));
            } else {
              const pemString = Uint8ArrayToString(base64ToUint8Array(loggedCertContent));
              loggedCert = X509Certificate4.parse(pemString);
            }
            if (!cert.equals(loggedCert)) {
              throw new Error("Certificate in Rekor log does not match the signing certificate.");
            }
          }
        } else if (bodyJson.kind === "dsse") {
          const verifierContent = bodyJson.spec.signatures?.[0]?.verifier;
          if (verifierContent) {
            const pemString = Uint8ArrayToString(base64ToUint8Array(verifierContent));
            const loggedCert = X509Certificate4.parse(pemString);
            if (!cert.equals(loggedCert)) {
              throw new Error("Certificate in DSSE tlog entry does not match the signing certificate.");
            }
          }
        } else if (bodyJson.kind === "intoto") {
          const publicKeyContent = bodyJson.spec.content?.envelope?.signatures?.[0]?.publicKey;
          if (publicKeyContent) {
            const pemString = Uint8ArrayToString(base64ToUint8Array(publicKeyContent));
            const loggedCert = X509Certificate4.parse(pemString);
            if (!cert.equals(loggedCert)) {
              throw new Error("Certificate in intoto tlog entry does not match the signing certificate.");
            }
          }
        } else {
          throw new Error(`Unsupported tlog entry kind: ${bodyJson.kind}`);
        }
        return true;
      }
      async verifyInclusionProof(bundle) {
        if (!this.rawRoot) {
          throw new Error("Sigstore root is undefined");
        }
        if (bundle.verificationMaterial.tlogEntries.length < 1) {
          throw new Error("No transparency log entries found in bundle");
        }
        for (const entry of bundle.verificationMaterial.tlogEntries) {
          if (entry.inclusionProof) {
            await verifyMerkleInclusion(entry);
            if (entry.inclusionProof.checkpoint) {
              await verifyCheckpoint(entry, this.rawRoot.tlogs);
            }
          }
        }
      }
      async verifyArtifactPolicy(policy, bundle, data, isDigestOnly = false) {
        if (!this.root) {
          throw new Error("Sigstore root is undefined");
        }
        const cert = bundle.verificationMaterial.certificate || bundle.verificationMaterial.x509CertificateChain?.certificates[0];
        if (!cert) {
          throw new Error("No certificate found in bundle");
        }
        const signingCert = X509Certificate4.parse(base64ToUint8Array(cert.rawBytes));
        let signature;
        if (bundle.messageSignature) {
          signature = base64ToUint8Array(bundle.messageSignature.signature);
        } else if (bundle.dsseEnvelope) {
          if (!bundle.dsseEnvelope.signatures || bundle.dsseEnvelope.signatures.length === 0) {
            throw new Error("DSSE envelope has no signatures");
          }
          signature = base64ToUint8Array(bundle.dsseEnvelope.signatures[0].sig);
        } else {
          throw new Error("Bundle does not contain a message signature or DSSE envelope");
        }
        policy.verify(signingCert);
        const certPath = await this.verifyCertificateChain(signingCert.notBefore, signingCert, this.root.certificateAuthorities);
        const issuerCert = certPath.length > 1 ? certPath[1] : certPath[0];
        const verifiedSCTs = await this.verifySCT(signingCert, issuerCert, this.root.ctlogs);
        if (verifiedSCTs.length < this.options.ctlogThreshold) {
          throw new Error(`Not enough valid SCTs: found ${verifiedSCTs.length}, required ${this.options.ctlogThreshold}`);
        }
        if (!await this.verifyInclusionPromise(signingCert, bundle, this.root.rekor)) {
          throw new Error("Inclusion promise validation failed.");
        }
        await this.verifyInclusionProof(bundle);
        for (const entry of bundle.verificationMaterial.tlogEntries) {
          await verifyTLogBody(entry, bundle);
        }
        const verifiedTimestamps = await verifyBundleTimestamp(bundle.verificationMaterial.timestampVerificationData, signature, this.rawRoot?.timestampAuthorities || []);
        if (verifiedTimestamps.length < this.options.tsaThreshold) {
          throw new Error(`Not enough verified TSA timestamps: ${verifiedTimestamps.length} < ${this.options.tsaThreshold}`);
        }
        for (const verifiedTimestamp of verifiedTimestamps) {
          if (!signingCert.validForDate(verifiedTimestamp)) {
            throw new Error("Certificate was not valid at the time of timestamping");
          }
        }
        if (bundle.dsseEnvelope) {
          const payloadBytes = base64ToUint8Array(bundle.dsseEnvelope.payload);
          const payload = JSON.parse(Uint8ArrayToString(payloadBytes));
          if (!payload.subject || payload.subject.length === 0) {
            throw new Error("DSSE payload has no subject");
          }
          let artifactDigest;
          if (isDigestOnly) {
            artifactDigest = Uint8ArrayToHex(data);
          } else {
            artifactDigest = Uint8ArrayToHex(new Uint8Array(await crypto.subtle.digest(HashAlgorithms.SHA256, data)));
          }
          let matchedSubject = null;
          for (const subject of payload.subject) {
            const subjectDigest = subject.digest?.["sha256"];
            if (subjectDigest && artifactDigest === subjectDigest.toLowerCase()) {
              matchedSubject = subject;
              break;
            }
          }
          if (!matchedSubject) {
            throw new Error(`Artifact digest ${artifactDigest} does not match any subject in DSSE payload`);
          }
          const pae = preAuthEncoding(bundle.dsseEnvelope.payloadType, payloadBytes);
          const publicKey = await signingCert.publicKeyObj;
          const verified = await verifySignature(publicKey, pae, signature);
          if (!verified) {
            throw new Error("DSSE signature verification failed");
          }
        } else {
          const publicKey = await signingCert.publicKeyObj;
          if (isDigestOnly) {
            const verified = await verifySignatureOverDigest(publicKey, data, signature);
            if (!verified) {
              throw new Error("Error verifying signature over digest");
            }
          } else {
            const verified = await verifySignature(publicKey, data, signature);
            if (!verified) {
              const keyAlg = publicKey.algorithm.name || "unknown";
              throw new Error(`Error verifying artifact signature. Key algorithm: ${keyAlg}, Data length: ${data.length}, Signature length: ${signature.length}`);
            }
          }
        }
        return true;
      }
      async verifyArtifact(identity, issuer, bundle, data, isDigestOnly = false) {
        const policy = new AllOf([
          new Identity({ identity }),
          new AnyOf([
            new OIDCIssuerV2(issuer),
            new OIDCIssuer(issuer)
          ])
        ]);
        return this.verifyArtifactPolicy(policy, bundle, data, isDigestOnly);
      }
      /**
       * Verify a DSSE bundle using a verification policy.
       * This matches sigstore-python's verify_dsse API.
       *
       * Reference: https://github.com/sigstore/sigstore-python/blob/main/sigstore/verify/verifier.py#L388
       *
       * Unlike verify_artifact which verifies an artifact against a bundle,
       * this method verifies the DSSE envelope itself and returns the payload.
       * The caller is responsible for checking that the payload matches their
       * expected artifact (e.g., by checking subjects in an in-toto statement).
       *
       * @param bundle - The Sigstore bundle containing the DSSE envelope
       * @param policy - A verification policy to apply to the signing certificate
       * @returns The payload type and payload bytes from the verified envelope
       */
      async verifyDsse(bundle, policy) {
        if (!this.root) {
          throw new Error("Sigstore root is undefined");
        }
        if (!bundle.dsseEnvelope) {
          throw new Error("Bundle does not contain a DSSE envelope");
        }
        const cert = bundle.verificationMaterial.certificate || bundle.verificationMaterial.x509CertificateChain?.certificates[0];
        if (!cert) {
          throw new Error("No certificate found in bundle");
        }
        const signingCert = X509Certificate4.parse(base64ToUint8Array(cert.rawBytes));
        const certPath = await this.verifyCertificateChain(signingCert.notBefore, signingCert, this.root.certificateAuthorities);
        const issuerCert = certPath.length > 1 ? certPath[1] : certPath[0];
        const verifiedSCTs = await this.verifySCT(signingCert, issuerCert, this.root.ctlogs);
        if (verifiedSCTs.length < this.options.ctlogThreshold) {
          throw new Error(`Not enough valid SCTs: found ${verifiedSCTs.length}, required ${this.options.ctlogThreshold}`);
        }
        policy.verify(signingCert);
        if (!await this.verifyInclusionPromise(signingCert, bundle, this.root.rekor)) {
          throw new Error("Inclusion promise validation failed");
        }
        await this.verifyInclusionProof(bundle);
        if (!bundle.dsseEnvelope.signatures || bundle.dsseEnvelope.signatures.length !== 1) {
          throw new Error(`DSSE envelope must have exactly 1 signature, got ${bundle.dsseEnvelope.signatures?.length ?? 0}`);
        }
        const signature = base64ToUint8Array(bundle.dsseEnvelope.signatures[0].sig);
        const verifiedTimestamps = await verifyBundleTimestamp(bundle.verificationMaterial.timestampVerificationData, signature, this.rawRoot?.timestampAuthorities || []);
        if (verifiedTimestamps.length < this.options.tsaThreshold) {
          throw new Error(`Not enough verified TSA timestamps: ${verifiedTimestamps.length} < ${this.options.tsaThreshold}`);
        }
        for (const verifiedTimestamp of verifiedTimestamps) {
          if (!signingCert.validForDate(verifiedTimestamp)) {
            throw new Error("Certificate was not valid at the time of timestamping");
          }
        }
        for (const entry of bundle.verificationMaterial.tlogEntries) {
          if (entry.integratedTime) {
            const integratedDate = new Date(Number(entry.integratedTime) * 1e3);
            if (!signingCert.validForDate(integratedDate)) {
              throw new Error("Artifact signing was logged outside of the certificate validity.");
            }
          } else {
            assertRekorV2Timestamp(bundle.verificationMaterial.timestampVerificationData);
          }
        }
        const payloadBytes = base64ToUint8Array(bundle.dsseEnvelope.payload);
        const pae = preAuthEncoding(bundle.dsseEnvelope.payloadType, payloadBytes);
        const publicKey = await signingCert.publicKeyObj;
        const verified = await verifySignature(publicKey, pae, signature);
        if (!verified) {
          throw new Error("DSSE signature verification failed");
        }
        for (const entry of bundle.verificationMaterial.tlogEntries) {
          if (entry.kindVersion.kind !== "dsse") {
            throw new Error(`Expected entry type dsse, got ${entry.kindVersion.kind}`);
          }
          await verifyTLogBody(entry, bundle);
        }
        return {
          payloadType: bundle.dsseEnvelope.payloadType,
          payload: payloadBytes
        };
      }
    };
  }
});

// node_modules/@freedomofpress/sigstore-browser/dist/index.js
var dist_exports = {};
__export(dist_exports, {
  AllOf: () => AllOf,
  AnyOf: () => AnyOf,
  CertificateChainVerifier: () => CertificateChainVerifier,
  CertificateError: () => CertificateError,
  EXTENSION_OID_BUILD_CONFIG_DIGEST: () => EXTENSION_OID_BUILD_CONFIG_DIGEST,
  EXTENSION_OID_BUILD_CONFIG_URI: () => EXTENSION_OID_BUILD_CONFIG_URI,
  EXTENSION_OID_BUILD_SIGNER_DIGEST: () => EXTENSION_OID_BUILD_SIGNER_DIGEST,
  EXTENSION_OID_BUILD_SIGNER_URI: () => EXTENSION_OID_BUILD_SIGNER_URI,
  EXTENSION_OID_BUILD_TRIGGER: () => EXTENSION_OID_BUILD_TRIGGER,
  EXTENSION_OID_FULCIO_ISSUER_V1: () => EXTENSION_OID_FULCIO_ISSUER_V1,
  EXTENSION_OID_FULCIO_ISSUER_V2: () => EXTENSION_OID_FULCIO_ISSUER_V2,
  EXTENSION_OID_GITHUB_WORKFLOW_NAME: () => EXTENSION_OID_GITHUB_WORKFLOW_NAME,
  EXTENSION_OID_GITHUB_WORKFLOW_REF: () => EXTENSION_OID_GITHUB_WORKFLOW_REF,
  EXTENSION_OID_GITHUB_WORKFLOW_REPOSITORY: () => EXTENSION_OID_GITHUB_WORKFLOW_REPOSITORY,
  EXTENSION_OID_GITHUB_WORKFLOW_SHA: () => EXTENSION_OID_GITHUB_WORKFLOW_SHA,
  EXTENSION_OID_GITHUB_WORKFLOW_TRIGGER: () => EXTENSION_OID_GITHUB_WORKFLOW_TRIGGER,
  EXTENSION_OID_OTHERNAME: () => EXTENSION_OID_OTHERNAME,
  EXTENSION_OID_RUNNER_ENVIRONMENT: () => EXTENSION_OID_RUNNER_ENVIRONMENT,
  EXTENSION_OID_RUN_INVOCATION_URI: () => EXTENSION_OID_RUN_INVOCATION_URI,
  EXTENSION_OID_SCT: () => EXTENSION_OID_SCT,
  EXTENSION_OID_SOURCE_REPOSITORY_DIGEST: () => EXTENSION_OID_SOURCE_REPOSITORY_DIGEST,
  EXTENSION_OID_SOURCE_REPOSITORY_IDENTIFIER: () => EXTENSION_OID_SOURCE_REPOSITORY_IDENTIFIER,
  EXTENSION_OID_SOURCE_REPOSITORY_OWNER_IDENTIFIER: () => EXTENSION_OID_SOURCE_REPOSITORY_OWNER_IDENTIFIER,
  EXTENSION_OID_SOURCE_REPOSITORY_OWNER_URI: () => EXTENSION_OID_SOURCE_REPOSITORY_OWNER_URI,
  EXTENSION_OID_SOURCE_REPOSITORY_REF: () => EXTENSION_OID_SOURCE_REPOSITORY_REF,
  EXTENSION_OID_SOURCE_REPOSITORY_URI: () => EXTENSION_OID_SOURCE_REPOSITORY_URI,
  EXTENSION_OID_SOURCE_REPOSITORY_VISIBILITY: () => EXTENSION_OID_SOURCE_REPOSITORY_VISIBILITY,
  GITHUB_OIDC_ISSUER: () => GITHUB_OIDC_ISSUER,
  GitHubWorkflowName: () => GitHubWorkflowName,
  GitHubWorkflowRef: () => GitHubWorkflowRef,
  GitHubWorkflowRepository: () => GitHubWorkflowRepository,
  GitHubWorkflowSHA: () => GitHubWorkflowSHA,
  GitHubWorkflowTrigger: () => GitHubWorkflowTrigger,
  Identity: () => Identity,
  OIDCBuildConfigDigest: () => OIDCBuildConfigDigest,
  OIDCBuildConfigURI: () => OIDCBuildConfigURI,
  OIDCBuildSignerDigest: () => OIDCBuildSignerDigest,
  OIDCBuildSignerURI: () => OIDCBuildSignerURI,
  OIDCBuildTrigger: () => OIDCBuildTrigger,
  OIDCIssuer: () => OIDCIssuer,
  OIDCIssuerV2: () => OIDCIssuerV2,
  OIDCRunInvocationURI: () => OIDCRunInvocationURI,
  OIDCRunnerEnvironment: () => OIDCRunnerEnvironment,
  OIDCSourceRepositoryDigest: () => OIDCSourceRepositoryDigest,
  OIDCSourceRepositoryIdentifier: () => OIDCSourceRepositoryIdentifier,
  OIDCSourceRepositoryOwnerIdentifier: () => OIDCSourceRepositoryOwnerIdentifier,
  OIDCSourceRepositoryOwnerURI: () => OIDCSourceRepositoryOwnerURI,
  OIDCSourceRepositoryRef: () => OIDCSourceRepositoryRef,
  OIDCSourceRepositoryURI: () => OIDCSourceRepositoryURI,
  OIDCSourceRepositoryVisibility: () => OIDCSourceRepositoryVisibility,
  PolicyError: () => PolicyError,
  SignatureError: () => SignatureError,
  SigstoreVerifier: () => SigstoreVerifier,
  TLogError: () => TLogError,
  TimestampError: () => TimestampError,
  TrustedRootProvider: () => TrustedRootProvider,
  VerificationError: () => VerificationError,
  X509BuildConfigDigestExtension: () => X509BuildConfigDigestExtension,
  X509BuildConfigURIExtension: () => X509BuildConfigURIExtension,
  X509BuildSignerDigestExtension: () => X509BuildSignerDigestExtension,
  X509BuildSignerURIExtension: () => X509BuildSignerURIExtension,
  X509BuildTriggerExtension: () => X509BuildTriggerExtension,
  X509Certificate: () => X509Certificate4,
  X509Extension: () => X509Extension,
  X509FulcioIssuerV1: () => X509FulcioIssuerV1,
  X509FulcioIssuerV2: () => X509FulcioIssuerV2,
  X509GitHubWorkflowNameExtension: () => X509GitHubWorkflowNameExtension,
  X509GitHubWorkflowRefExtension: () => X509GitHubWorkflowRefExtension,
  X509GitHubWorkflowRepositoryExtension: () => X509GitHubWorkflowRepositoryExtension,
  X509GitHubWorkflowSHAExtension: () => X509GitHubWorkflowSHAExtension,
  X509GitHubWorkflowTriggerExtension: () => X509GitHubWorkflowTriggerExtension,
  X509RunInvocationURIExtension: () => X509RunInvocationURIExtension,
  X509RunnerEnvironmentExtension: () => X509RunnerEnvironmentExtension,
  X509SourceRepositoryDigestExtension: () => X509SourceRepositoryDigestExtension,
  X509SourceRepositoryIdentifierExtension: () => X509SourceRepositoryIdentifierExtension,
  X509SourceRepositoryOwnerIdentifierExtension: () => X509SourceRepositoryOwnerIdentifierExtension,
  X509SourceRepositoryOwnerURIExtension: () => X509SourceRepositoryOwnerURIExtension,
  X509SourceRepositoryRefExtension: () => X509SourceRepositoryRefExtension,
  X509SourceRepositoryURIExtension: () => X509SourceRepositoryURIExtension,
  X509SourceRepositoryVisibilityExtension: () => X509SourceRepositoryVisibilityExtension,
  verifyBundleTimestamp: () => verifyBundleTimestamp,
  verifyRFC3161Timestamp: () => verifyRFC3161Timestamp
});
var init_dist2 = __esm({
  "node_modules/@freedomofpress/sigstore-browser/dist/index.js"() {
    init_sigstore();
    init_errors();
    init_tsa();
    init_tuf2();
    init_cert();
    init_ext();
    init_chain();
    init_policy();
  }
});

// verifier/consumer.mjs
import https from "node:https";
import { isIP } from "node:net";
import { createHash as createHash4, X509Certificate as X509Certificate5 } from "node:crypto";
import { gunzipSync as gunzipSync2 } from "node:zlib";

// verifier/envelope.mjs
import { gunzipSync } from "node:zlib";
var TECH = { SNP: "amd-sev-snp", TDX: "intel-tdx", AVF: "android-avf", VBS: "windows-vbs-enclave", HYPERV: "hyperv-partition", WINHOST: "windows-tpm-host", NONE: "none" };
var b64 = (max, required = false) => ({ kind: "b64", max, required });
var hexF = (n, required = false) => ({ kind: "hex", n, required });
var str = (max, required = false) => ({ kind: "str", max, required });
var obj = (required = false) => ({ kind: "obj", required });
var oneOf = (values, required = false) => ({ kind: "oneOf", values, required });
var MAX_DOC_BYTES = 1024 * 1024;
var MAX_DOC_KEYS = 32;
var SHAPES = {
  hosted: { body: "body", closed: true, fields: {} },
  metal: { body: "body", closed: false, fields: { transportKey: b64(4096), transportKeyFp: hexF(64), padKey: hexF(64), certs: b64(96 * 1024), name: str(128), manifest: obj(), volumes: obj() } },
  domain: { body: "report", closed: false, fields: { tier: str(16), transportKey: b64(4096), appSha256: hexF(64), nonce: hexF(64), abi: oneOf(["enclave-domain-abi/1", "enclave-domain-abi/2"]), runtime: obj(), runtimeSelfTest: str(4096), certs: b64(96 * 1024), boundary: obj(), reason: str(1024) } },
  avf1: { body: "body", closed: false, fields: { transportKey: b64(4096), padKey: hexF(64) } },
  avf2: { body: "body", closed: false, fields: { transportKey: b64(4096), padKey: hexF(64, true) } },
  vbs: { body: "body", closed: false, fields: { transportKey: b64(4096), padKey: hexF(64) } },
  hyperv: { body: "report", closed: false, fields: { tier: str(16), nonce: hexF(64), appSha256: hexF(64), transportKey: b64(4096), reason: str(1024) } }
};
var FORMATS = Object.freeze({
  "https://tinfoil.sh/predicate/sev-snp-guest/v2": { technology: TECH.SNP, family: "hosted-tinfoil", binding: "hosted-tinfoil", gzip: true, supported: true, shape: SHAPES.hosted },
  "https://tinfoil.sh/predicate/sev-snp-guest/v1": { technology: TECH.SNP, family: "hosted-tinfoil", binding: "hosted-tinfoil", gzip: false, supported: false, why: "legacy Tinfoil v1 predicate" },
  "sev-snp-guest-metal-v1": { technology: TECH.SNP, family: "metal", binding: "spki", gzip: false, supported: true, shape: SHAPES.metal },
  "sev-snp-guest-domain-v1": { technology: TECH.SNP, family: "domain", binding: "domain", gzip: false, supported: true, shape: SHAPES.domain },
  "tdx-guest-metal-v1": { technology: TECH.TDX, family: "metal", binding: "spki", gzip: false, supported: false, why: "Intel TDX quote verification is not implemented (DCAP collateral, QE identity, TCB info)" },
  "https://tinfoil.sh/predicate/tdx-guest/v1": { technology: TECH.TDX, family: "hosted-tinfoil", binding: "hosted-tinfoil", gzip: true, supported: false, why: "Intel TDX quote verification is not implemented" },
  "android-avf-pvm/v1": { technology: TECH.AVF, family: "pvm", binding: "avf-transcript", gzip: false, supported: "delegate", shape: SHAPES.avf1 },
  "android-avf-pvm/v2": { technology: TECH.AVF, family: "pvm", binding: "avf-pad-transcript", gzip: false, supported: "delegate", shape: SHAPES.avf2 },
  // client-verified pVM app evidence (pVM owner's proposal, 2026-09-24): a JSON object, not a base64 body; routed
  // by verifier/index.mjs to verifier/pvm-evidence.mjs before parseEnvelope, which is why it has no body here
  "enclave-pvm-app-evidence/v1": { technology: TECH.AVF, family: "pvm-app", binding: "abi2-client-nonce", gzip: false, supported: "delegate", jsonObject: true },
  "enclave-pvm-app-evidence/v2": { technology: TECH.AVF, family: "pvm-app", binding: "abi2-client-nonce", gzip: false, supported: "delegate", jsonObject: true, appKey: true },
  // v3 (INSTANCE-BINDING.md, 2026-09-24): v2 plus the VM instance inside the challenge (Bind3) and an instance signature
  "enclave-pvm-app-evidence/v3": { technology: TECH.AVF, family: "pvm-app", binding: "abi3-client-nonce-instance", gzip: false, supported: "delegate", jsonObject: true, appKey: true, instance: true },
  "windows-vbs-enclave/v1": { technology: TECH.VBS, family: "consumer-node", binding: "vbs-transcript", gzip: false, supported: "delegate", shape: SHAPES.vbs },
  "hyperv-partition-domain/v1": { technology: TECH.HYPERV, family: "domain", binding: "domain", gzip: false, supported: "delegate", hostExcluded: false, shape: SHAPES.hyperv },
  // The NucBox node's attach evidence proposed by enclave-5d on 2026-09-25 for the custom type-1 path (Steven: the only NucBox
  // target): the node's own transport key bound to its TPM's measured boot state (EK chain, credential round trip, quote, log
  // replay, Secure Boot on, test signing off). The relay judges it; it is a HOST statement with no TEE claim and the host is
  // not excluded, so it is never a confidential-compute verdict here (docs/security/nucbox-custom-vm-verifier.md).
  "windows-hv-node/v1": {
    technology: TECH.WINHOST,
    family: "consumer-node",
    binding: "hv-node-transcript",
    gzip: false,
    supported: false,
    hostExcluded: false,
    why: "a host-attested boot state (TPM quote over the measured boot, judged by the relay's module): no TEE claim, the host is not excluded, never a confidential-compute verdict"
  },
  "dev-unattested-metal-v1": { technology: TECH.NONE, family: "dev", binding: null, gzip: false, supported: false, rejected: true, why: "development format: proves nothing about hardware by definition" },
  "none": { technology: TECH.NONE, family: "t0", binding: null, gzip: false, supported: false, rejected: true, why: "a T0 domain has no hardware report" }
});
var MAX_BODY_B64 = 64 * 1024;
var MAX_BODY_BYTES = 64 * 1024;
var MAX_GUNZIP_BYTES = 64 * 1024;
var EnvelopeError = class extends Error {
  constructor(code, msg) {
    super(msg);
    this.code = code;
  }
};
var B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
function checkBase64(s, max, what) {
  if (typeof s !== "string" || !s.length) throw new EnvelopeError("malformed", `${what}: missing`);
  if (s.length > max) throw new EnvelopeError("malformed", `${what}: ${s.length} chars exceeds the ${max}-char cap`);
  if (!B64.test(s)) throw new EnvelopeError("malformed", `${what}: not strict base64`);
  return s;
}
var utf8Length = (s) => typeof Buffer !== "undefined" ? Buffer.byteLength(s) : new TextEncoder().encode(s).length;
function validateEnvelope(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new EnvelopeError("malformed", "evidence is not an object");
  if (typeof doc.format !== "string" || !doc.format || doc.format.length > 200) throw new EnvelopeError("malformed", "evidence.format is not a short string");
  const spec = FORMATS[doc.format];
  if (!spec) throw new EnvelopeError("unsupported", `unknown evidence format ${JSON.stringify(doc.format)}: nothing is known about what it proves`);
  if (spec.rejected) throw new EnvelopeError("rejected", `${doc.format}: ${spec.why}`);
  if (spec.supported === false) throw new EnvelopeError("unsupported", `${doc.format}: ${spec.why}`);
  const shape = spec.shape || { body: "body", closed: false, fields: {} };
  const keys = Object.keys(doc);
  if (keys.length > MAX_DOC_KEYS) throw new EnvelopeError("malformed", `${doc.format}: ${keys.length} top-level fields exceeds the cap of ${MAX_DOC_KEYS}`);
  let size = 0;
  try {
    size = utf8Length(JSON.stringify(doc));
  } catch {
    throw new EnvelopeError("malformed", `${doc.format}: the document is not serialisable`);
  }
  if (size > MAX_DOC_BYTES) throw new EnvelopeError("malformed", `${doc.format}: ${size} bytes exceeds the document cap of ${MAX_DOC_BYTES}`);
  const other = shape.body === "body" ? "report" : "body";
  if (other in doc) throw new EnvelopeError("malformed", `${doc.format}: carries \`${other}\` but this format's body field is \`${shape.body}\` (no alias)`);
  if (!(shape.body in doc)) throw new EnvelopeError("malformed", `${doc.format} ${shape.body}: missing`);
  const allowed = /* @__PURE__ */ new Set(["format", shape.body, ...Object.keys(shape.fields)]);
  if (shape.closed) {
    for (const k of keys) if (!allowed.has(k)) throw new EnvelopeError("malformed", `${doc.format}: unexpected field \`${k}\` (the format's shape is closed: nothing outside it is bound or read)`);
  }
  for (const [name, f] of Object.entries(shape.fields)) {
    if (!(name in doc)) {
      if (f.required) throw new EnvelopeError("malformed", `${doc.format}: ${name} is required by this format`);
      continue;
    }
    const v = doc[name], bad = (why) => {
      throw new EnvelopeError("malformed", `${doc.format}: ${name} ${why}`);
    };
    if (f.kind === "b64") {
      if (typeof v !== "string" || !v.length) bad("must be a non-empty base64 string");
      if (v.length > f.max) bad(`exceeds ${f.max} chars`);
      if (!B64.test(v)) bad("is not strict base64");
    } else if (f.kind === "hex") {
      if (typeof v !== "string" || v.length !== f.n || !/^[0-9a-f]+$/.test(v)) bad(`must be ${f.n} lowercase hex chars`);
    } else if (f.kind === "str") {
      if (typeof v !== "string" || v.length > f.max) bad(`must be a string of at most ${f.max} chars`);
    } else if (f.kind === "obj") {
      if (!v || typeof v !== "object" || Array.isArray(v)) bad("must be a JSON object");
    } else if (f.kind === "oneOf") {
      if (!f.values.includes(v)) bad(`must be one of ${f.values.join(", ")}`);
    }
  }
  const bodyB64 = checkBase64(doc[shape.body], MAX_BODY_B64, `${doc.format} ${shape.body}`);
  return { format: doc.format, spec, shape, bodyB64 };
}
function parseEnvelope(doc) {
  const { spec, shape, bodyB64 } = validateEnvelope(doc);
  let body = Buffer.from(bodyB64, "base64");
  if (body.length > MAX_BODY_BYTES) throw new EnvelopeError("malformed", "body exceeds the byte cap");
  const gz = body.length >= 2 && body[0] === 31 && body[1] === 139;
  if (spec.gzip) {
    if (!gz) throw new EnvelopeError("malformed", `${doc.format}: body must be gzip`);
    try {
      body = gunzipSync(body, { maxOutputLength: MAX_GUNZIP_BYTES });
    } catch (e) {
      throw new EnvelopeError("malformed", `${doc.format}: gzip body unreadable or over the cap (${e.message})`);
    }
  } else if (gz) throw new EnvelopeError("malformed", `${doc.format}: body is gzip but the format is not`);
  return { format: doc.format, spec, body, doc, shape };
}

// verifier/snp.mjs
import { X509Certificate as X509Certificate2, constants, verify as cryptoVerify } from "node:crypto";

// relay/snp-verify.mjs
var KDS = "https://kdsintf.amd.com";
var MAX_KDS_BYTES = 256 * 1024;
var AMD_ARK_SHA256 = /* @__PURE__ */ new Map([
  ["Milan", "69d063b45344d26a2e94e1f4210de49ef555308287d4c174445c95639a540bcd"],
  ["Genoa", "4c6598d19c18719c5dfd4a7d335f674e5bfe1d8f800cea2cf270c10d103db2f1"],
  ["Turin", "1f084161a44bb6d93778a904877d4819cafa5d05ef4193b2ded9dd9c73dd3f6a"]
]);
var TCB_FIELDS = {
  Milan: ["bootloader", "tee", "snp", "microcode"],
  Genoa: ["bootloader", "tee", "snp", "microcode"],
  Turin: ["fmc", "bootloader", "tee", "snp", "microcode"]
};
function decodeTcb(product, b) {
  if (product === "Turin") return { fmc: b[0], bootloader: b[1], tee: b[2], snp: b[3], microcode: b[7] };
  if (product === "Milan" || product === "Genoa") return { bootloader: b[0], tee: b[1], snp: b[6], microcode: b[7] };
  throw new Error(`no TCB layout for product line ${product}`);
}
var fmtTcb = (t) => Object.entries(t).map(([k, v]) => `${k} ${v}`).join(", ");
function snpProductHint(p) {
  if (p.version < 3) return null;
  const fam = p.cpuidFam, mod2 = p.cpuidMod;
  if (fam === 25 && mod2 < 16) return "Milan";
  if (fam === 25 && (mod2 >= 16 && mod2 < 32 || mod2 >= 160 && mod2 < 176)) return "Genoa";
  if (fam === 26 && mod2 < 32) return "Turin";
  return null;
}
function kdsVcekUrl(product, p) {
  const t = decodeTcb(product, p.reportedTcb);
  if (product === "Turin") {
    const d = (n) => String(n).padStart(2, "0");
    return `${KDS}/vcek/v1/Turin/${p.chipId.subarray(0, 8).toString("hex")}?fmcSPL=${d(t.fmc)}&blSPL=${d(t.bootloader)}&teeSPL=${d(t.tee)}&snpSPL=${d(t.snp)}&ucodeSPL=${d(t.microcode)}`;
  }
  return `${KDS}/vcek/v1/${product}/${p.chipId.toString("hex")}?blSPL=${t.bootloader}&teeSPL=${t.tee}&snpSPL=${t.snp}&ucodeSPL=${t.microcode}`;
}
function derAt(b, o) {
  if (o + 2 > b.length) throw new Error("DER truncated");
  let len = b[o + 1], p = o + 2;
  if (len & 128) {
    const n = len & 127;
    if (n < 1 || n > 4) throw new Error("DER length form");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[p++];
  }
  if (p + len > b.length) throw new Error("DER overrun");
  return { tag: b[o], start: p, end: p + len };
}
function derKids(b, t) {
  const out = [];
  for (let o = t.start; o < t.end; ) {
    const k = derAt(b, o);
    out.push(k);
    o = k.end;
  }
  return out;
}
function oidOf(b) {
  const parts = [Math.floor(b[0] / 40), b[0] % 40];
  for (let i = 1, v = 0; i < b.length; i++) {
    v = v * 128 + (b[i] & 127);
    if (!(b[i] & 128)) {
      parts.push(v);
      v = 0;
    }
  }
  return parts.join(".");
}
function certExtensions(der) {
  const tbs = derKids(der, derAt(der, 0))[0];
  const ext2 = derKids(der, tbs).find((k) => k.tag === 163);
  const out = /* @__PURE__ */ new Map();
  if (!ext2) return out;
  for (const e of derKids(der, derKids(der, ext2)[0])) {
    const kids = derKids(der, e), oid2 = kids[0], val = kids[kids.length - 1];
    if (oid2.tag === 6 && val.tag === 4) out.set(oidOf(der.subarray(oid2.start, oid2.end)), der.subarray(val.start, val.end));
  }
  return out;
}
function derUint(v) {
  const t = derAt(v, 0);
  if (t.tag !== 2 || t.end !== v.length || t.end === t.start || v[t.start] & 128) return null;
  let n = 0;
  for (let i = t.start; i < t.end; i++) n = n * 256 + v[i];
  return n;
}
var AMD = "1.3.6.1.4.1.3704.1";
var SPL_OID = { bootloader: `${AMD}.3.1`, tee: `${AMD}.3.2`, snp: `${AMD}.3.3`, microcode: `${AMD}.3.8`, fmc: `${AMD}.3.9` };
function vcekMatchesReport(vcekDer, product, p) {
  let ext2;
  try {
    ext2 = certExtensions(vcekDer);
  } catch (e) {
    return `VCEK extensions unreadable: ${e.message}`;
  }
  const want = decodeTcb(product, p.reportedTcb);
  for (const field of TCB_FIELDS[product]) {
    const raw = ext2.get(SPL_OID[field]);
    if (!raw) return `VCEK has no ${field} SPL extension (${SPL_OID[field]})`;
    const got = derUint(raw);
    if (got !== want[field]) return `VCEK ${field} SPL ${got} does not match the report's reported TCB ${want[field]}`;
  }
  const hwLen = product === "Turin" ? 8 : 64;
  let hw = ext2.get(`${AMD}.4`);
  if (!hw) return `VCEK has no hardware-ID extension (${AMD}.4)`;
  if (hw.length !== hwLen && hw[0] === 4) {
    try {
      const t = derAt(hw, 0);
      hw = hw.subarray(t.start, t.end);
    } catch {
    }
  }
  if (hw.length !== hwLen) return `VCEK hardware ID is ${hw.length} bytes, ${product} uses ${hwLen}`;
  if (!hw.equals(p.chipId.subarray(0, hwLen))) return "VCEK hardware ID does not match the report's CHIP_ID";
  return null;
}
function checkMinTcb(minTcb, product, p) {
  const reported = product && TCB_FIELDS[product] ? decodeTcb(product, p.reportedTcb) : null;
  if (minTcb === void 0)
    return { ok: true, checked: false, reported, reason: "TCB: no minimum-TCB policy supplied, so the firmware level is NOT judged" };
  const bad = (why) => ({ ok: false, checked: false, reported, reason: why });
  if (!minTcb || typeof minTcb !== "object" || Array.isArray(minTcb)) return bad("minimum-TCB policy malformed: not an object keyed by product line");
  const lines = Object.keys(minTcb);
  if (!lines.length) return bad("minimum-TCB policy malformed: names no product line");
  for (const line of lines) {
    const f = minTcb[line], fields = TCB_FIELDS[line];
    if (!fields) return bad(`minimum-TCB policy malformed: unknown product line "${line}"`);
    if (!f || typeof f !== "object" || Array.isArray(f)) return bad(`minimum-TCB policy malformed: ${line} is not an object`);
    for (const k of Object.keys(f)) if (!fields.includes(k)) return bad(`minimum-TCB policy malformed: ${line} has unknown field "${k}"`);
    for (const k of fields)
      if (!Number.isInteger(f[k]) || f[k] < 0 || f[k] > 255) return bad(`minimum-TCB policy malformed: ${line}.${k} must be an integer 0-255`);
  }
  if (!product) return bad("cannot judge the TCB: the report's product line is unknown");
  const floor = minTcb[product];
  if (!floor) return bad(`the minimum-TCB policy has no floor for ${product}`);
  for (const k of TCB_FIELDS[product])
    if (reported[k] < floor[k]) return bad(`reported TCB below policy: ${product} ${k} ${reported[k]} < ${floor[k]}`);
  return { ok: true, checked: true, reported, reason: `reported TCB meets the supplied ${product} minimum (${fmtTcb(reported)})` };
}

// verifier/der.mjs
var toHex = (b) => {
  let s = "";
  for (let i = 0; i < b.length; i++) s += (b[i] < 16 ? "0" : "") + b[i].toString(16);
  return s;
};
var latin1 = (b) => {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
};
function tlv(b, off, limit = b.length) {
  if (!Number.isSafeInteger(off) || off < 0 || off + 2 > limit || limit > b.length) throw new Error("DER truncated");
  const tag = b[off];
  if ((tag & 31) === 31) throw new Error("DER long-form tag unsupported");
  let len = b[off + 1], p = off + 2;
  if (len === 128) throw new Error("DER indefinite length refused");
  if (len & 128) {
    const n = len & 127;
    if (n < 1 || n > 4 || p + n > limit) throw new Error("DER length form");
    if (b[p] === 0) throw new Error("DER non-minimal length");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[p++];
    if (len < 128) throw new Error("DER non-minimal length");
  }
  if (p + len > limit) throw new Error("DER element overruns its parent");
  return { tag, start: p, end: p + len, hdr: off };
}
function children(b, node, cap = 4096) {
  if (!(node.tag & 32)) throw new Error("DER parent is not constructed");
  const out = [];
  let p = node.start;
  while (p < node.end) {
    if (out.length >= cap) throw new Error("DER: too many children");
    const c = tlv(b, p, node.end);
    out.push(c);
    p = c.end;
  }
  return out;
}
var bytes = (b, n) => b.subarray(n.start, n.end);
var whole = (b, n) => b.subarray(n.hdr, n.end);
function oid(b, n) {
  const v = bytes(b, n);
  if (!v.length) throw new Error("empty OID");
  const parts = [Math.floor(v[0] / 40), v[0] % 40];
  for (let i = 1, x = 0; i < v.length; i++) {
    x = x * 128 + (v[i] & 127);
    if (!(v[i] & 128)) {
      parts.push(x);
      x = 0;
    }
  }
  return parts.join(".");
}
function integer(b, n) {
  if (n.tag !== 2) throw new Error("DER: not an INTEGER");
  let v = bytes(b, n);
  if (!v.length) throw new Error("DER: empty INTEGER");
  if (v[0] & 128) throw new Error("DER: negative INTEGER where a serial was expected");
  while (v.length > 1 && v[0] === 0) v = v.subarray(1);
  return toHex(v);
}
function time(b, n) {
  const s = latin1(bytes(b, n));
  let m;
  if (n.tag === 23 && (m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s))) {
    const yy = +m[1];
    return new Date(Date.UTC(yy >= 50 ? 1900 + yy : 2e3 + yy, +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  }
  if (n.tag === 24 && (m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s)))
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  throw new Error(`DER: unsupported time ${JSON.stringify(s)} (tag 0x${n.tag.toString(16)})`);
}
function parseCrl(der, { maxRevoked = 4096 } = {}) {
  if (!(der instanceof Uint8Array) || der.length < 8 || der.length > 1 << 20) throw new Error("CRL: not a bounded DER buffer");
  const top = tlv(der, 0);
  if (top.tag !== 48 || top.end !== der.length) throw new Error("CRL: not one SEQUENCE");
  const [tbs, sigAlg, sigVal] = children(der, top);
  if (!tbs || !sigAlg || !sigVal || sigVal.tag !== 3) throw new Error("CRL: shape");
  const k = children(der, tbs);
  let i = 0;
  const version = k[i].tag === 2 ? (i++, integer(der, k[i - 1])) : "00";
  const tbsSigAlg = k[i++], algOid = oid(der, children(der, tbsSigAlg)[0]);
  const issuer = k[i++];
  const thisUpdate = time(der, k[i++]);
  let nextUpdate = null;
  if (k[i] && (k[i].tag === 23 || k[i].tag === 24)) nextUpdate = time(der, k[i++]);
  const revoked = [];
  if (k[i] && k[i].tag === 48) {
    for (const e of children(der, k[i], maxRevoked)) {
      const [serial, date] = children(der, e);
      revoked.push({ serial: integer(der, serial), date: time(der, date) });
    }
    i++;
  }
  const sig = bytes(der, sigVal);
  if (sig[0] !== 0) throw new Error("CRL: BIT STRING with unused bits");
  return {
    version,
    algOid,
    issuerDer: whole(der, issuer),
    thisUpdate,
    nextUpdate,
    revoked,
    tbsDer: whole(der, tbs),
    signature: sig.subarray(1),
    sigAlgIsRsaPss: algOid === "1.2.840.113549.1.1.10",
    // the two AlgorithmIdentifiers as bytes (RFC 5280 5.1.1.2: they must be the same), for a profile that pins them
    sigAlgDer: whole(der, sigAlg),
    tbsSigAlgDer: whole(der, tbsSigAlg)
  };
}
function subjectNameDer(certDer) {
  const tbs = children(certDer, tlv(certDer, 0))[0];
  const k = children(certDer, tbs);
  let i = 0;
  if (k[0].tag === 160) i++;
  i++;
  i++;
  i++;
  i++;
  return whole(certDer, k[i]);
}

// verifier/tls-binding.mjs
import { createHash, X509Certificate } from "node:crypto";
var sha256 = (...parts) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
};
function spkiOfCert(pemOrDer) {
  const c = new X509Certificate(pemOrDer);
  return { spki: c.publicKey.export({ type: "spki", format: "der" }), cert: c };
}
var B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Decode(s) {
  s = s.toUpperCase().replace(/=+$/, "");
  const out = [];
  let bits = 0, val = 0;
  for (const ch of s) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error(`base32: bad char ${JSON.stringify(ch)}`);
    val = val << 5 | i;
    bits += 5;
    if (bits >= 8) {
      out.push(val >> bits - 8 & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
function decodeLabelledSans(sans, label) {
  const parts = sans.filter((d) => d.includes(`.${label}.`)).map((d) => {
    const m = /^(\d{2})([a-z2-7]+)\./i.exec(d);
    if (!m) throw new Error(`SAN ${d} is not NN<base32>.${label}.<zone>`);
    return [+m[1], m[2]];
  });
  if (!parts.length) throw new Error(`no .${label}. SANs`);
  parts.sort((a, b) => a[0] - b[0]);
  parts.forEach(([n], i) => {
    if (n !== i) throw new Error(`.${label}. SAN chunks are not 00..${parts.length - 1} (found ${n} at ${i})`);
  });
  return base32Decode(parts.map((p) => p[1]).join(""));
}
var dnsSans = (cert) => (cert.subjectAltName || "").split(",").map((s) => s.trim()).filter((s) => s.startsWith("DNS:")).map((s) => s.slice(4));
var hashAttestationDocument = (doc) => sha256(Buffer.from(String(doc.format) + String(doc.body), "utf8")).toString("hex");
function checkHostedCertificate({ certPem, host, doc, hpkeKeyHex, now = /* @__PURE__ */ new Date() }) {
  const reasons = [], fail = (m) => ({ ok: false, reasons: [...reasons, m], claims: null });
  let cert;
  try {
    cert = new X509Certificate(certPem);
  } catch (e) {
    return fail(`served certificate unparseable: ${e.message}`);
  }
  if (now < new Date(cert.validFrom) || now > new Date(cert.validTo)) return fail(`served certificate not valid at ${now.toISOString()} (${cert.validFrom} .. ${cert.validTo})`);
  const sans = dnsSans(cert);
  if (!host || !cert.checkHost(host)) return fail(`served certificate is not valid for host ${JSON.stringify(host)}`);
  reasons.push(`served certificate names ${host}, valid ${cert.validFrom} .. ${cert.validTo}`);
  let hpke, hatt;
  try {
    hpke = decodeLabelledSans(sans, "hpke").toString("hex");
    hatt = decodeLabelledSans(sans, "hatt").toString("utf8");
  } catch (e) {
    return fail(`certificate SAN encoding: ${e.message}`);
  }
  if (!/^[0-9a-f]{64}$/.test(hpke)) return fail("certificate hpke SAN does not decode to 32 bytes");
  if (hpke !== hpkeKeyHex) return fail("certificate HPKE key differs from the key the report states in report_data[32:64]");
  reasons.push("certificate hpke SANs encode the HPKE key the report states");
  const want = hashAttestationDocument(doc);
  if (hatt !== want) return fail("certificate hatt SANs do not encode sha256(format + body) of this document (a substituted document)");
  reasons.push("certificate hatt SANs bind this exact attestation document");
  return { ok: true, reasons, claims: { hpkePublicKey: hpke, attestationHash: want, tlsSpkiSha256: sha256(cert.publicKey.export({ type: "spki", format: "der" })).toString("hex"), notAfter: cert.validTo } };
}

// verifier/snp.mjs
var REPORT_SIZE = 1184;
var SIG_OFFSET = 672;
var MAX_REPORT_VERSION = 6;
var JUDGED_MAX_REPORT_VERSION = 5;
var verdictStatus = (omissions) => omissions.length ? "limited" : "verified";
var P384_N = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffc7634d81f4372ddf581a0db248b0a77aecec196accc52973");
var VCEK_GUID = "63da758de6644564adc5f4b93be8accd";
var hex = (b) => Buffer.from(b).toString("hex");
var fpHex = (cert) => String(cert.fingerprint256 || "").replace(/:/g, "").toLowerCase();
var cn = (dn) => (/(?:^|\n)CN=([^\n]+)/.exec(dn || "") || [])[1] || null;
var DEFAULT_SNP_POLICY = Object.freeze({
  allowedProducts: ["Milan", "Genoa", "Turin"],
  roots: AMD_ARK_SHA256,
  // product -> sha256 of the ARK (relay/snp-verify.mjs, corroborated against go-sev-guest)
  product: null,
  // required for report version 2 (no CPUID in the report); must agree with CPUID for v3+
  expectedVmpl: 0,
  guestPolicy: { debug: false, migrateMa: false, smt: "any", singleSocket: "any", cxlAllowed: "any", memAes256Xts: "any", raplDis: "any", ciphertextHidingDram: "any", pageSwapDisabled: "any" },
  minTcb: void 0,
  // { Product: { field: n } } per relay/snp-verify.mjs checkMinTcb; applied to reported AND committed TCB
  minFirmware: void 0,
  // { major, minor, build }: applied to current AND committed firmware version
  allowedMeasurements: [],
  // hex; empty = refuse (a verifier with no expected measurement has nothing to compare)
  crl: "required",
  // required | stale-ok | none
  crlMaxStaleDays: 0,
  requireCertificateBinding: true,
  // hosted format: the served certificate must be supplied and must bind this document
  researchAllowUnjudgedReportVersions: false
  // RESEARCH ONLY: run the checks on a report version whose new fields are unjudged; the result is at best "limited"
});
function parseReportStrict(r) {
  if (!Buffer.isBuffer(r)) throw new Error("report is not a byte buffer");
  if (r.length !== REPORT_SIZE) throw new Error(`report is ${r.length} bytes; the ABI fixes ATTESTATION_REPORT at ${REPORT_SIZE}`);
  const u32 = (o) => r.readUInt32LE(o), u64 = (o) => r.readBigUInt64LE(o);
  const p = {
    version: u32(0),
    guestSvn: u32(4),
    policy: u64(8),
    familyId: r.subarray(16, 32),
    imageId: r.subarray(32, 48),
    vmpl: u32(48),
    signatureAlgo: u32(52),
    currentTcb: r.subarray(56, 64),
    platformInfo: u64(64),
    signerInfo: u32(72),
    reportData: r.subarray(80, 144),
    measurement: r.subarray(144, 192),
    hostData: r.subarray(192, 224),
    idKeyDigest: r.subarray(224, 272),
    authorKeyDigest: r.subarray(272, 320),
    reportId: r.subarray(320, 352),
    reportIdMa: r.subarray(352, 384),
    reportedTcb: r.subarray(384, 392),
    cpuidFam: r[392],
    cpuidMod: r[393],
    cpuidStep: r[394],
    chipId: r.subarray(416, 480),
    committedTcb: r.subarray(480, 488),
    currentBuild: r[488],
    currentMinor: r[489],
    currentMajor: r[490],
    committedBuild: r[492],
    committedMinor: r[493],
    committedMajor: r[494],
    launchTcb: r.subarray(496, 504),
    launchMitVector: r.subarray(504, 512),
    currentMitVector: r.subarray(512, 520),
    // ABI Rev 1.59 (report version 6): extended TCB fields, parsed for display only, never judged here
    currentEtcb: r.subarray(544, 576),
    launchEtcb: r.subarray(576, 608),
    committedEtcb: r.subarray(608, 640),
    signature: r.subarray(SIG_OFFSET, SIG_OFFSET + 144),
    signedRegion: r.subarray(0, SIG_OFFSET)
  };
  if (p.version < 2) throw new Error(`report version ${p.version} < 2`);
  if (p.version > MAX_REPORT_VERSION) throw new Error(`report version ${p.version} is newer than this parser knows (ABI Rev 1.59 = version ${MAX_REPORT_VERSION})`);
  if (!(p.policy & 1n << 17n)) throw new Error("guest policy reserved bit 17 is not 1");
  if (p.policy >> 26n) throw new Error("guest policy bits 63:26 are not zero");
  if (p.signatureAlgo !== 1) throw new Error(`signature algorithm ${p.signatureAlgo} is not ECDSA P-384 with SHA-384 (1)`);
  if (p.signerInfo >>> 5) throw new Error("signer_info bits 31:5 are not zero");
  p.signingKey = p.signerInfo >>> 2 & 7;
  p.maskChipKey = !!(p.signerInfo & 2);
  p.authorKeyEn = !!(p.signerInfo & 1);
  if (p.signingKey !== 0) throw new Error(`report signed by key type ${p.signingKey} (1 = VLEK, 7 = none); only VCEK-signed reports chain to AMD's public roots here`);
  const mbz = (lo, hi, what) => {
    for (let i = lo; i < hi; i++) if (r[i]) throw new Error(`reserved bytes (${what}) are not zero`);
  };
  mbz(76, 80, "0x4c..0x50");
  mbz(p.version >= 3 ? 395 : 392, 416, "after CPUID");
  mbz(491, 492, "0x1eb");
  mbz(495, 496, "0x1ef");
  if (p.version <= 5) mbz(520, SIG_OFFSET, "0x208..0x2a0, version <= 5");
  mbz(SIG_OFFSET + 48, SIG_OFFSET + 72, "signature R zero-extension");
  mbz(SIG_OFFSET + 120, SIG_OFFSET + 144, "signature S zero-extension");
  mbz(SIG_OFFSET + 144, REPORT_SIZE, "signature tail");
  p.productHint = snpProductHint(p);
  p.policyBits = {
    abiMinor: Number(p.policy & 0xffn),
    abiMajor: Number(p.policy >> 8n & 0xffn),
    smt: !!(p.policy & 1n << 16n),
    migrateMa: !!(p.policy & 1n << 18n),
    debug: !!(p.policy & 1n << 19n),
    singleSocket: !!(p.policy & 1n << 20n),
    cxlAllowed: !!(p.policy & 1n << 21n),
    memAes256Xts: !!(p.policy & 1n << 22n),
    raplDis: !!(p.policy & 1n << 23n),
    ciphertextHidingDram: !!(p.policy & 1n << 24n),
    pageSwapDisabled: !!(p.policy & 1n << 25n)
  };
  p.platformBits = { smtEnabled: !!(p.platformInfo & 1n), tsmeEnabled: !!(p.platformInfo & 2n), eccEnabled: !!(p.platformInfo & 4n), raplDisabled: !!(p.platformInfo & 8n), ciphertextHidingDram: !!(p.platformInfo & 16n), aliasCheckComplete: !!(p.platformInfo & 32n), tioEnabled: !!(p.platformInfo & 128n) };
  return p;
}
function vcekFromAuxblob(aux) {
  if (!Buffer.isBuffer(aux) || aux.length > 64 * 1024) return null;
  for (let o = 0; o + 24 <= aux.length; o += 24) {
    const guid = hex(aux.subarray(o, o + 16));
    if (/^0+$/.test(guid)) break;
    const off = aux.readUInt32LE(o + 16), len = aux.readUInt32LE(o + 20);
    if (guid === VCEK_GUID) return off + len <= aux.length && len > 0 ? aux.subarray(off, off + len) : null;
  }
  return null;
}
function verifyReportSignature(p, vcekCert) {
  const rBE = Buffer.from(p.signature.subarray(0, 48)).reverse(), sBE = Buffer.from(p.signature.subarray(72, 72 + 48)).reverse();
  const R = BigInt("0x" + hex(rBE)), S = BigInt("0x" + hex(sBE));
  if (R === 0n || R >= P384_N || S === 0n || S >= P384_N) return { ok: false, why: "signature r or s is out of range for P-384" };
  const k = vcekCert.publicKey;
  if (k.asymmetricKeyType !== "ec" || k.asymmetricKeyDetails?.namedCurve !== "secp384r1") return { ok: false, why: "VCEK public key is not EC P-384" };
  let ok = false;
  try {
    ok = cryptoVerify("sha384", p.signedRegion, { key: k, dsaEncoding: "ieee-p1363" }, Buffer.concat([rBE, sBE]));
  } catch (e) {
    return { ok: false, why: `signature check error: ${e.message}` };
  }
  return { ok, why: ok ? null : "VCEK signature over the report is invalid" };
}
var pemCerts = (pem) => String(pem).split(/(?=-----BEGIN CERTIFICATE-----)/).filter((s) => s.includes("CERTIFICATE")).map((s) => new X509Certificate2(s));
var inWindow = (c, now) => now >= new Date(c.validFrom) && now <= new Date(c.validTo);
function parseAmdChain({ chainPem, product, now, roots = AMD_ARK_SHA256 }) {
  const fail = (why) => ({ ok: false, why });
  let chain;
  try {
    chain = pemCerts(chainPem);
  } catch (e) {
    return fail(`AMD chain unparseable: ${e.message}`);
  }
  if (chain.length !== 2) return fail(`AMD cert_chain must be exactly ASK then ARK (got ${chain.length} certificates)`);
  const [ask, ark] = chain;
  const want = roots.get(product);
  if (!want) return fail(`no pinned AMD root for product line ${JSON.stringify(product)} (fail closed)`);
  if (fpHex(ark) !== want) return fail(`the served ARK (${fpHex(ark).slice(0, 16)}...) is not AMD's pinned ${product} root`);
  if (cn(ark.subject) !== `ARK-${product}`) return fail(`ARK subject CN is ${cn(ark.subject)}, expected ARK-${product}`);
  if (cn(ask.subject) !== `SEV-${product}`) return fail(`ASK subject CN is ${cn(ask.subject)}, expected SEV-${product}`);
  for (const [c, what] of [[ark, "ARK"], [ask, "ASK"]]) if (!inWindow(c, now)) return fail(`${what} certificate is not valid at ${now.toISOString()} (${c.validFrom} .. ${c.validTo})`);
  for (const [c, what] of [[ark, "ARK"], [ask, "ASK"]]) if (c.publicKey.asymmetricKeyType !== "rsa" || c.publicKey.asymmetricKeyDetails?.modulusLength !== 4096) return fail(`${what} key is not RSA-4096`);
  if (!ark.verify(ark.publicKey)) return fail("ARK is not self-signed");
  if (!ask.checkIssued(ark) || !ask.verify(ark.publicKey)) return fail("ASK is not signed by the ARK");
  return { ok: true, why: null, ask, ark };
}
function checkChain({ vcekDer, chainPem, product, now, roots = AMD_ARK_SHA256 }) {
  const reasons = [], fail = (why) => ({ ok: false, why, reasons });
  let vcek;
  try {
    vcek = new X509Certificate2(vcekDer);
  } catch (e) {
    return fail(`VCEK unparseable: ${e.message}`);
  }
  const c = parseAmdChain({ chainPem, product, now, roots });
  if (!c.ok) return fail(c.why);
  const { ask, ark } = c;
  if (cn(vcek.subject) !== "SEV-VCEK") return fail(`VCEK subject CN is ${cn(vcek.subject)}, expected SEV-VCEK`);
  if (cn(vcek.issuer) !== `SEV-${product}`) return fail(`VCEK issuer CN is ${cn(vcek.issuer)}, expected SEV-${product}`);
  if (!inWindow(vcek, now)) return fail(`VCEK certificate is not valid at ${now.toISOString()} (${vcek.validFrom} .. ${vcek.validTo})`);
  if (!vcek.checkIssued(ask) || !vcek.verify(ask.publicKey)) return fail("VCEK is not signed by the ASK");
  reasons.push(`AMD chain verified: VCEK -> ASK (SEV-${product}) -> ARK-${product}, ARK pinned by sha256, all three valid at ${now.toISOString().slice(0, 10)}`);
  return { ok: true, why: null, reasons, vcek, ask, ark };
}
function checkCrlAuthentic({ crlDer, ark, now }) {
  let crl;
  try {
    crl = parseCrl(crlDer);
  } catch (e) {
    return { ok: false, why: `CRL unparseable: ${e.message}` };
  }
  if (!crl.sigAlgIsRsaPss) return { ok: false, why: `CRL signature algorithm ${crl.algOid} is not RSASSA-PSS` };
  if (!crl.issuerDer.equals(subjectNameDer(ark.raw))) return { ok: false, why: "CRL issuer is not the pinned ARK" };
  let sigOk = false;
  try {
    sigOk = cryptoVerify("sha384", crl.tbsDer, { key: ark.publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 48 }, crl.signature);
  } catch (e) {
    return { ok: false, why: `CRL signature error: ${e.message}` };
  }
  if (!sigOk) return { ok: false, why: "CRL signature does not verify with the pinned ARK" };
  if (now < crl.thisUpdate) return { ok: false, why: `CRL thisUpdate ${crl.thisUpdate.toISOString()} is in the future` };
  return { ok: true, why: null, crl };
}
function checkCrl({ crlDer, ark, ask, now, mode = "required", maxStaleDays = 0 }) {
  const pre = crlPolicyPrelude({ crlDer, mode });
  if (pre) return pre;
  const a = checkCrlAuthentic({ crlDer, ark, now });
  if (!a.ok) return { ok: false, checked: false, reasons: [a.why] };
  return judgeCrl({ crl: a.crl, askSerialHex: ask.serialNumber, now, mode, maxStaleDays });
}
function crlPolicyPrelude({ crlDer, mode = "required" }) {
  if (mode === "none") return { ok: true, checked: false, reasons: ["CRL: policy 'none': revocation of the ASK was NOT checked"] };
  if (!crlDer) return mode === "required" ? { ok: false, checked: false, reasons: ["CRL: required by policy but none was supplied"] } : { ok: true, checked: false, reasons: ["CRL: none supplied; policy stale-ok continues WITHOUT a revocation check (say so to the user)"] };
  return null;
}
function judgeCrl({ crl, askSerialHex, now, mode = "required", maxStaleDays = 0 }) {
  const reasons = [];
  let stale = false;
  if (crl.nextUpdate && now > crl.nextUpdate) {
    const staleDays = (now - crl.nextUpdate) / 864e5;
    if (mode === "required" || staleDays > maxStaleDays) return { ok: false, checked: true, reasons: [`CRL is stale: nextUpdate ${crl.nextUpdate.toISOString()} is ${staleDays.toFixed(1)} days past (policy ${mode}${mode === "stale-ok" ? `, max ${maxStaleDays}` : ""})`] };
    reasons.push(`CRL is ${staleDays.toFixed(1)} days past nextUpdate; accepted under policy stale-ok (${maxStaleDays} days)`);
    stale = true;
  }
  const askSerial = String(askSerialHex).toLowerCase().replace(/^0+(?=.)/, "");
  const hit = crl.revoked.find((e) => e.serial.replace(/^0+(?=.)/, "") === askSerial);
  if (hit) return { ok: false, checked: true, reasons: [`the ASK (serial ${askSerialHex}) is REVOKED since ${hit.date.toISOString()}`] };
  reasons.push(`CRL verified (ARK-signed, ${crl.revoked.length} revoked serial(s), valid ${crl.thisUpdate.toISOString().slice(0, 10)} .. ${crl.nextUpdate ? crl.nextUpdate.toISOString().slice(0, 10) : "?"}); ASK serial ${askSerialHex} not revoked`);
  return { ok: true, checked: true, stale, reasons, nextUpdate: crl.nextUpdate };
}
var NODE_CRYPTO = Object.freeze({ checkChain, checkCrl, verifyReportSignature, sha256, checkHostedCertificate, certRaw: (c) => c.raw, certFp: fpHex });
var tcbHex = (b) => hex(b);
var fw = (maj, min, build) => `${maj}.${min} build ${build}`;
async function verifySnp(env, policy = {}, context = {}, collateral = null) {
  const pol = { ...DEFAULT_SNP_POLICY, ...policy, guestPolicy: { ...DEFAULT_SNP_POLICY.guestPolicy, ...policy.guestPolicy || {} } };
  const X = context.crypto || NODE_CRYPTO;
  const now = context.now ? new Date(context.now) : /* @__PURE__ */ new Date();
  const reasons = [], checks = {}, omissions = [], claims = { technology: "amd-sev-snp", format: env.format, family: env.spec.family };
  const out = (status) => ({ status, admissionSafe: status === "verified", omissions, reasons, checks, claims });
  const omit = (name, why) => {
    omissions.push(name);
    reasons.push(`OMITTED (${name}): ${why}`);
  };
  const fail = (name, why) => {
    checks[name] = false;
    reasons.push(`REJECT: ${why}`);
    return out("rejected");
  };
  const pass = (name, why) => {
    checks[name] = true;
    reasons.push(why);
  };
  let p;
  try {
    p = parseReportStrict(env.body);
  } catch (e) {
    return fail("report shape", e.message);
  }
  Object.assign(claims, {
    reportVersion: p.version,
    vmpl: p.vmpl,
    guestSvn: p.guestSvn,
    measurement: hex(p.measurement),
    reportData: hex(p.reportData),
    hostData: hex(p.hostData),
    chipId: hex(p.chipId),
    reportId: hex(p.reportId),
    guestPolicy: p.policyBits,
    platformInfo: p.platformBits,
    firmware: { current: fw(p.currentMajor, p.currentMinor, p.currentBuild), committed: fw(p.committedMajor, p.committedMinor, p.committedBuild) },
    idKeyDigest: hex(p.idKeyDigest),
    authorKeyDigest: hex(p.authorKeyDigest),
    authorKeyEn: p.authorKeyEn,
    maskChipKey: p.maskChipKey
  });
  pass("report shape", `report version ${p.version}, ${REPORT_SIZE} bytes, VCEK-signed, ECDSA P-384, reserved ranges zero`);
  if (p.version > JUDGED_MAX_REPORT_VERSION) {
    claims.unjudgedFields = { currentEtcb: hex(p.currentEtcb), launchEtcb: hex(p.launchEtcb), committedEtcb: hex(p.committedEtcb), reserved0x208: hex(env.body.subarray(520, 544)), reserved0x280: hex(env.body.subarray(640, SIG_OFFSET)) };
    const why = `report version ${p.version} (ABI Rev 1.59) carries CURRENT_ETCB, LAUNCH_ETCB and COMMITTED_ETCB (0x220..0x280) whose policy semantics and reserved ranges this verifier has not implemented or tested; the judged range is versions 2..${JUDGED_MAX_REPORT_VERSION}`;
    if (!pol.researchAllowUnjudgedReportVersions) {
      checks["report version"] = null;
      reasons.push(`UNSUPPORTED: ${why}`);
      return out("unsupported");
    }
    checks["report version"] = null;
    omit("report-version-unjudged", `${why} (researchAllowUnjudgedReportVersions: the verdict can be "limited" at best)`);
  } else checks["report version"] = true;
  let product = p.productHint;
  if (!product) {
    if (p.version >= 3) return fail("product line", `CPUID family 0x${p.cpuidFam.toString(16)} model 0x${p.cpuidMod.toString(16)} is not a known product line`);
    if (!pol.product) return fail("product line", "report version 2 carries no CPUID; policy.product must name the product line");
    product = pol.product;
  } else if (pol.product && pol.product !== product) return fail("product line", `policy expects ${pol.product} but the report's CPUID names ${product}`);
  if (!pol.allowedProducts.includes(product)) return fail("product line", `${product} is not an allowed product line (${pol.allowedProducts.join(", ")})`);
  claims.product = product;
  pass("product line", `product line ${product}${p.version >= 3 ? " (from the report's CPUID, confirmed below by the chain)" : " (from policy)"}`);
  if (p.policyBits.debug) return fail("guest policy", `guest policy 0x${p.policy.toString(16)} allows DEBUG: the host can read guest memory`);
  if (p.policyBits.migrateMa) return fail("guest policy", `guest policy 0x${p.policy.toString(16)} allows MIGRATE_MA`);
  for (const k of ["smt", "singleSocket", "cxlAllowed", "memAes256Xts", "raplDis", "ciphertextHidingDram", "pageSwapDisabled"]) {
    const want = pol.guestPolicy[k];
    if (want === "any" || want === void 0) continue;
    if (!!want !== p.policyBits[k]) return fail("guest policy", `guest policy ${k}=${p.policyBits[k]} but policy requires ${want}`);
  }
  pass("guest policy", `guest policy 0x${p.policy.toString(16)}: DEBUG off, MIGRATE_MA off, SMT ${p.policyBits.smt ? "allowed" : "off"}, ABI ${p.policyBits.abiMajor}.${p.policyBits.abiMinor}`);
  if (!Number.isInteger(pol.expectedVmpl) || pol.expectedVmpl < 0 || pol.expectedVmpl > 3) return fail("vmpl", `policy.expectedVmpl must be 0..3`);
  if (p.vmpl !== pol.expectedVmpl) return fail("vmpl", `report is from VMPL${p.vmpl}, policy expects VMPL${pol.expectedVmpl}`);
  pass("vmpl", p.vmpl === 0 ? "report is from VMPL0 (full privilege inside the guest)" : `report is from VMPL${p.vmpl} as expected (VMPL0..${p.vmpl - 1} of this guest are in its TCB)`);
  const tcb = decodeTcb(product, p.reportedTcb);
  const tcbHexStr = tcbHex(p.reportedTcb), chipHex = hex(p.chipId);
  const prov = (r) => r ? { source: r.source ?? null, fetchedAt: r.fetchedAt ?? null, cached: r.cached === true, ...r.stale !== void 0 ? { stale: r.stale === true } : {} } : null;
  claims.collateral = { vcek: null, chain: null, crl: null };
  let vcekDer = context.auxblob ? vcekFromAuxblob(context.auxblob) : null, vcekSource = vcekDer ? "the report's own certificate table" : null;
  if (vcekDer) claims.collateral.vcek = { source: vcekSource, fetchedAt: null, cached: false };
  if (!vcekDer && collateral) {
    try {
      const v = await collateral.vcek(product, chipHex, tcbHexStr, kdsVcekUrl(product, p).replace(/^https:\/\/[^/]+\//, ""));
      if (v) {
        vcekDer = v.der;
        vcekSource = v.source;
        claims.collateral.vcek = prov(v);
      }
    } catch (e) {
      return fail("vcek", `VCEK unavailable: ${e.message}`);
    }
  }
  if (!vcekDer) return fail("vcek", "no VCEK: not in the certificate table and no collateral source answered (the chain cannot be verified; nothing below is authenticated)");
  let chainPem;
  try {
    const c = await collateral?.chain(product);
    chainPem = c?.pem;
    claims.collateral.chain = prov(c);
  } catch (e) {
    return fail("chain", `AMD chain unavailable: ${e.message}`);
  }
  if (!chainPem) return fail("chain", `no AMD ASK/ARK chain for ${product} available`);
  const ch = await X.checkChain({ vcekDer, chainPem, product, now, roots: pol.roots });
  if (!ch.ok) return fail("chain", ch.why);
  checks.chain = true;
  reasons.push(...ch.reasons);
  claims.vcekSource = vcekSource;
  claims.vcekFingerprint = X.certFp(ch.vcek);
  claims.arkFingerprint = X.certFp(ch.ark);
  let crlDer = null;
  try {
    const c = await collateral?.crl?.(product);
    crlDer = c?.der ?? null;
    claims.collateral.crl = prov(c);
  } catch (e) {
    crlDer = null;
    claims.collateral.crl = { source: null, fetchedAt: null, cached: false, error: e.message };
  }
  const crl = await X.checkCrl({ crlDer, ark: ch.ark, ask: ch.ask, now, mode: pol.crl, maxStaleDays: pol.crlMaxStaleDays });
  reasons.push(...crl.reasons);
  if (!crl.ok) {
    checks.crl = false;
    return out("rejected");
  }
  checks.crl = crl.checked ? true : null;
  claims.crlChecked = crl.checked;
  if (crl.nextUpdate) claims.crlNextUpdate = crl.nextUpdate.toISOString();
  if (!crl.checked) omit("crl-revocation-unchecked", `ASK revocation was not checked (policy crl: ${pol.crl}${crlDer ? "" : ", no CRL supplied"})`);
  else if (crl.stale) omit("crl-stale-accepted", `the CRL is past nextUpdate and was accepted under policy stale-ok (${pol.crlMaxStaleDays} days)`);
  const sig = await X.verifyReportSignature(p, ch.vcek);
  if (!sig.ok) return fail("signature", sig.why);
  pass("signature", "PSP signature over bytes 0..0x2a0 verifies with the VCEK (r, s in range)");
  const mm = vcekMatchesReport(X.certRaw(ch.vcek), product, p);
  if (mm) return fail("vcek identity", mm);
  pass("vcek identity", `VCEK extensions name this chip (${chipHex.slice(0, 16)}...) and the reported TCB (${TCB_FIELDS[product].map((k) => `${k} ${tcb[k]}`).join(", ")})`);
  claims.tcb = { reported: tcb, current: decodeTcb(product, p.currentTcb), committed: decodeTcb(product, p.committedTcb), launch: decodeTcb(product, p.launchTcb) };
  const t = checkMinTcb(pol.minTcb, product, p);
  if (!t.ok) return fail("tcb policy", t.reason);
  if (t.checked) {
    const floor = pol.minTcb[product];
    const low = TCB_FIELDS[product].filter((k) => claims.tcb.committed[k] < floor[k]);
    if (low.length) return fail("tcb policy", `committed TCB below policy: ${low.map((k) => `${k} ${claims.tcb.committed[k]} < ${floor[k]}`).join(", ")} (the platform may roll back to it)`);
  }
  checks["tcb policy"] = t.checked ? true : null;
  if (t.checked) reasons.push(`${t.reason}; committed TCB meets it too`);
  else omit("tcb-floor-unjudged", `${t.reason}; the reported TCB is shown in the claims, not judged`);
  if (pol.minFirmware) {
    const { major, minor, build } = pol.minFirmware;
    const geq = (M, m, b) => M > major || M === major && (m > minor || m === minor && b >= build);
    if (!geq(p.currentMajor, p.currentMinor, p.currentBuild) || !geq(p.committedMajor, p.committedMinor, p.committedBuild)) return fail("firmware", `firmware current ${claims.firmware.current} / committed ${claims.firmware.committed} below policy ${fw(major, minor, build)}`);
    pass("firmware", `firmware ${claims.firmware.current} (committed ${claims.firmware.committed}) meets the floor`);
  }
  const allow = new Set((pol.allowedMeasurements || []).map((m) => String(m).toLowerCase()));
  if (!allow.size) return fail("measurement", "policy names no allowed measurement: a verifier with nothing expected has nothing to compare (fail closed)");
  if (!allow.has(claims.measurement)) return fail("measurement", `launch measurement ${claims.measurement.slice(0, 16)}... is not an allowed measurement`);
  pass("measurement", "launch measurement is one the policy allows (from verified provenance, or the caller's explicit expectation)");
  const rd0 = p.reportData.subarray(0, 32), rd1 = p.reportData.subarray(32, 64);
  const spki = context.transportKeySpki;
  if (!Buffer.isBuffer(spki) || spki.length < 44 || spki.length > 2048) return fail("binding", "no transport key SPKI from the verifier's own handshake: the binding cannot be checked (never skipped)");
  const spkiHash = Buffer.from(await X.sha256(spki));
  claims.transportSpkiSha256 = hex(spkiHash);
  if (env.spec.binding === "hosted-tinfoil") {
    if (!spkiHash.equals(rd0)) return fail("binding", "report_data[0:32] != sha256(the TLS key this connection presented): the report belongs to another key");
    claims.hpkePublicKey = hex(rd1);
    claims.tlsSpkiSha256 = hex(spkiHash);
    pass("binding", "report_data[0:32] binds the served TLS key (hosted format: no nonce in the report; freshness rests on the served certificate)");
    if (context.certPem) {
      const c = await X.checkHostedCertificate({ certPem: context.certPem, host: context.host, doc: env.doc, hpkeKeyHex: claims.hpkePublicKey, now });
      reasons.push(...c.reasons);
      if (!c.ok) {
        checks["certificate binding"] = false;
        return out("rejected");
      }
      if (c.claims.tlsSpkiSha256 !== claims.tlsSpkiSha256) return fail("certificate binding", "the served certificate's key is not the key the report binds");
      checks["certificate binding"] = true;
      claims.certificate = c.claims;
    } else if (pol.requireCertificateBinding) return fail("certificate binding", "hosted format requires the served certificate (hatt SAN binds the document; without it a replayed document over a fresh key is not excluded)");
    else {
      checks["certificate binding"] = null;
      omit("certificate-binding-unchecked", "the served certificate was not checked (policy.requireCertificateBinding=false): document freshness is not established");
    }
  } else if (env.spec.binding === "spki") {
    if (context.nonce && context.nonce.length !== 32) return fail("binding", "nonce must be 32 bytes");
    const want = Buffer.from(context.nonce ? await X.sha256(spki, context.nonce) : spkiHash);
    if (!want.equals(rd0)) return fail("binding", context.nonce ? "report_data[0:32] != sha256(SPKI || nonce): stale, replayed, or another key" : "report_data[0:32] != sha256(SPKI): another key");
    if (!rd1.equals(Buffer.alloc(32))) return fail("binding", "report_data[32:64] is not zero for the metal format");
    if (context.nonce) pass("binding", "report_data[0:32] binds the transport key and this verifier's fresh nonce");
    else {
      checks.binding = true;
      reasons.push("report_data[0:32] binds the transport key");
      omit("freshness-unbound", "no verifier nonce: the report proves key possession at attest time, not freshness (a replayed report is not excluded)");
    }
  } else if (env.spec.binding === "domain") {
    let want, abi;
    if (context.expectedBinding) {
      if (!Buffer.isBuffer(context.expectedBinding) || context.expectedBinding.length !== 32) return fail("binding", "expectedBinding must be 32 bytes");
      want = context.expectedBinding;
      abi = "ABI/2 (caller-derived Bind2 over key, nonce and runtime identity)";
    } else if (context.nonce) {
      if (context.nonce.length !== 32) return fail("binding", "nonce must be 32 bytes");
      want = Buffer.from(await X.sha256(spki, context.nonce));
      abi = "ABI/1 sha256(SPKI || nonce)";
    } else return fail("binding", "domain format needs a nonce (ABI/1) or an expectedBinding (ABI/2)");
    if (env.doc.abi === "enclave-domain-abi/2" !== !!context.expectedBinding) return fail("binding", `the document states abi ${env.doc.abi ?? "enclave-domain-abi/1"} but the verifier expected ${context.expectedBinding ? "ABI/2" : "ABI/1"}: no silent downgrade`);
    if (!want.equals(rd0)) return fail("binding", `report_data[0:32] does not equal the ${abi} binding`);
    if (!Buffer.isBuffer(context.expectedAppId) || context.expectedAppId.length !== 32) return fail("app id", "domain format needs the expected app id (32 bytes)");
    if (!rd1.equals(context.expectedAppId)) return fail("app id", `report_data[32:64] names app ${hex(rd1).slice(0, 16)}..., expected ${hex(context.expectedAppId).slice(0, 16)}...`);
    claims.appId = hex(rd1);
    claims.abi = env.doc.abi ?? "enclave-domain-abi/1";
    pass("binding", `report_data[0:32] equals the ${abi} binding`);
    pass("app id", "report_data[32:64] names the expected app");
  } else return fail("binding", `no binding rule for format ${env.format}`);
  if (context.expectedHostData !== void 0) {
    if (!Buffer.isBuffer(context.expectedHostData) || context.expectedHostData.length !== 32) return fail("host data", "expectedHostData must be exactly 32 bytes (the bytes32 deployment id)");
    if (p.hostData.equals(Buffer.alloc(32))) return fail("host data", "report HOST_DATA is all zero: this guest was launched without a deployment binding, refused when one is expected (never read as unbound)");
    if (!p.hostData.equals(context.expectedHostData)) return fail("host data", `report HOST_DATA names ${hex(p.hostData).slice(0, 16)}..., not the expected deployment ${hex(context.expectedHostData).slice(0, 16)}...`);
    pass("host data", "report HOST_DATA equals the expected deployment id (the host's launch-time binding, PSP-signed)");
  }
  claims.freshness = env.spec.binding === "hosted-tinfoil" ? checks["certificate binding"] ? "served certificate window" : "none (certificate binding omitted)" : context.nonce || context.expectedBinding ? "verifier nonce" : "none (key possession only)";
  return out(verdictStatus(omissions));
}

// verifier/collateral.mjs
import fs from "node:fs";
import path from "node:path";
function fileCollateral(dir, { vceks = {}, chains = {}, crls = {} } = {}) {
  const read = (p) => {
    try {
      return fs.readFileSync(p);
    } catch {
      return null;
    }
  };
  const stamp = (p) => {
    try {
      return fs.statSync(p).mtime.toISOString();
    } catch {
      return null;
    }
  };
  return {
    kind: "file",
    chain(product) {
      const p = chains[product] || path.join(dir, "amd", `${product}-cert_chain.pem`);
      const b = read(p);
      if (!b) throw new Error(`no AMD chain on file for ${product} (${p})`);
      return { pem: b.toString("utf8"), source: `file:${p}`, fetchedAt: stamp(p) };
    },
    vcek(product, chipIdHex, tcbHex2) {
      const key = `${product}-${chipIdHex}-${tcbHex2}`;
      const p = vceks[key] || vceks[product] || path.join(dir, "vcek", `${key}.der`);
      const b = read(p);
      return b ? { der: b, source: `file:${p}`, fetchedAt: stamp(p) } : null;
    },
    crl(product) {
      const p = crls[product] || path.join(dir, "amd", `${product}-crl.der`);
      const b = read(p);
      return b ? { der: b, source: `file:${p}`, fetchedAt: stamp(p) } : null;
    }
  };
}
function memoryCollateral({ chains = {}, vceks = {}, crls = {} } = {}) {
  return {
    kind: "memory",
    chain: (product) => {
      if (!chains[product]) throw new Error(`no AMD chain held for ${product}`);
      return { pem: chains[product], source: "memory" };
    },
    vcek: (product, chipIdHex, tcbHex2) => {
      const d = vceks[`${product}-${chipIdHex}-${tcbHex2}`] || vceks[product];
      return d ? { der: d, source: "memory" } : null;
    },
    crl: (product) => crls[product] ? { der: crls[product], source: "memory" } : null
  };
}
var AMD_KDS = "https://kdsintf.amd.com";
function httpCollateral({ base = AMD_KDS, timeoutMs = 8e3, maxBytes = 256 * 1024, fetchImpl = globalThis.fetch } = {}) {
  async function get(url) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(url, { signal: ctrl.signal });
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      const chunks = [];
      let seen = 0;
      for await (const c of r.body ?? []) {
        seen += c.length;
        if (seen > maxBytes) {
          ctrl.abort();
          throw new Error(`${url}: body exceeds ${maxBytes} bytes`);
        }
        chunks.push(Buffer.from(c));
      }
      return Buffer.concat(chunks);
    } finally {
      clearTimeout(t);
    }
  }
  const now = () => (/* @__PURE__ */ new Date()).toISOString();
  return {
    kind: "http",
    base,
    async chain(product) {
      return { pem: (await get(`${base}/vcek/v1/${product}/cert_chain`)).toString("utf8"), source: `${base}/vcek/v1/${product}/cert_chain`, fetchedAt: now() };
    },
    async vcek(product, chipIdHex, tcbHex2, kdsPath) {
      const url = `${base}/${kdsPath}`;
      return { der: await get(url), source: url, fetchedAt: now() };
    },
    async crl(product) {
      const url = `${base}/vcek/v1/${product}/crl`;
      return { der: await get(url), source: url, fetchedAt: now() };
    }
  };
}
function layeredCollateral(...adapters) {
  const first = async (fn) => {
    let last = null;
    for (const a of adapters) {
      try {
        const r = await fn(a);
        if (r) return r;
      } catch (e) {
        last = e;
      }
    }
    if (last) throw last;
    return null;
  };
  return {
    kind: "layered",
    chain: (product) => first((a) => a.chain(product)),
    vcek: (product, chip, tcb, kdsPath) => first((a) => a.vcek(product, chip, tcb, kdsPath)),
    crl: (product) => first((a) => a.crl(product))
  };
}

// verifier/collateral-cache.mjs
import fs2 from "node:fs";
import path2 from "node:path";
import { createHash as createHash2, X509Certificate as X509Certificate3 } from "node:crypto";
var sha2562 = (b) => createHash2("sha256").update(b).digest("hex");
var cn2 = (dn) => (/(?:^|\n)CN=([^\n]+)/.exec(dn || "") || [])[1] || null;
var safe = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, "_");
function cachedCollateral({ dir, upstream = null, now = () => /* @__PURE__ */ new Date(), roots = AMD_ARK_SHA256 } = {}) {
  if (!dir) throw new Error("cachedCollateral needs a directory");
  const events = [], stats = { hits: 0, misses: 0, fetches: 0, quarantined: 0, writeFailures: 0, staleServed: 0 };
  const note = (kind, key, why) => events.push({ kind, key, why });
  const file = (product, name) => path2.join(dir, safe(product), name);
  const read = (f) => {
    try {
      return fs2.readFileSync(f);
    } catch {
      return null;
    }
  };
  const meta = (f) => {
    try {
      return JSON.parse(fs2.readFileSync(`${f}.meta.json`, "utf8"));
    } catch {
      return null;
    }
  };
  const quarantine = (f, why) => {
    stats.quarantined++;
    note("quarantined", f, why);
    try {
      fs2.renameSync(f, `${f}.rejected-${Date.now()}`);
    } catch {
    }
    try {
      fs2.rmSync(`${f}.meta.json`, { force: true });
    } catch {
    }
  };
  const write = (f, bytes2, m) => {
    try {
      fs2.mkdirSync(path2.dirname(f), { recursive: true });
      const tmp = `${f}.${process.pid}-${Math.random().toString(16).slice(2)}.tmp`;
      fs2.writeFileSync(tmp, bytes2);
      fs2.renameSync(tmp, f);
      fs2.writeFileSync(`${f}.meta.json`, JSON.stringify({ sha256: sha2562(bytes2), ...m, validatedAt: now().toISOString() }) + "\n");
      return true;
    } catch (e) {
      stats.writeFailures++;
      note("cache-write-failed", f, e.message);
      return false;
    }
  };
  const chainMemo = /* @__PURE__ */ new Map();
  async function chain(product) {
    const f = file(product, "chain.pem");
    const cached = read(f);
    if (cached) {
      const m = meta(f), c2 = parseAmdChain({ chainPem: cached.toString("utf8"), product, now: now(), roots });
      if (c2.ok && m && m.sha256 === sha2562(cached)) {
        stats.hits++;
        chainMemo.set(product, c2);
        return { pem: cached.toString("utf8"), source: `cache:${f}`, fetchedAt: m.fetchedAt ?? null, cached: true };
      }
      quarantine(f, c2.ok ? "sidecar missing or its sha256 does not match the bytes" : c2.why);
    } else stats.misses++;
    if (!upstream) throw new Error(`no AMD chain for ${product}: not cached and no upstream source`);
    stats.fetches++;
    const r = await upstream.chain(product);
    if (!r || typeof r.pem !== "string") throw new Error(`no AMD chain for ${product} from ${upstream.kind || "upstream"}`);
    const c = parseAmdChain({ chainPem: r.pem, product, now: now(), roots });
    if (!c.ok) {
      note("upstream-refused", `${product} chain from ${r.source}`, c.why);
      throw new Error(`AMD chain from ${r.source} failed authentication: ${c.why}`);
    }
    chainMemo.set(product, c);
    write(f, Buffer.from(r.pem, "utf8"), { source: r.source ?? null, fetchedAt: r.fetchedAt ?? now().toISOString() });
    return { pem: r.pem, source: r.source ?? "upstream", fetchedAt: r.fetchedAt ?? null, cached: false };
  }
  async function askOf(product) {
    if (!chainMemo.has(product)) await chain(product);
    return chainMemo.get(product);
  }
  const vcekWhy = (der, product, ask, chipIdHex, tcbHex2) => {
    let v;
    try {
      v = new X509Certificate3(der);
    } catch (e) {
      return `VCEK unparseable: ${e.message}`;
    }
    if (cn2(v.subject) !== "SEV-VCEK") return `VCEK subject CN is ${cn2(v.subject)}`;
    if (cn2(v.issuer) !== `SEV-${product}`) return `VCEK issuer CN is ${cn2(v.issuer)}, expected SEV-${product}`;
    const t = now();
    if (t < new Date(v.validFrom) || t > new Date(v.validTo)) return `VCEK not valid at ${t.toISOString()}`;
    if (v.publicKey.asymmetricKeyType !== "ec" || v.publicKey.asymmetricKeyDetails?.namedCurve !== "secp384r1") return "VCEK key is not EC P-384";
    if (!v.checkIssued(ask) || !v.verify(ask.publicKey)) return "VCEK is not signed by the ASK";
    const mismatch = vcekMatchesReport(der, product, { chipId: Buffer.from(chipIdHex, "hex"), reportedTcb: Buffer.from(tcbHex2, "hex") });
    if (mismatch) return `${mismatch} (the slot ${chipIdHex.slice(0, 16)}.../${tcbHex2}: an authentic certificate for another chip or TCB is not this slot's)`;
    return null;
  };
  async function vcek(product, chipIdHex, tcbHex2, kdsPath) {
    if (!/^[0-9a-f]{128}$/.test(chipIdHex || "") || !/^[0-9a-f]{16}$/.test(tcbHex2 || "")) throw new Error(`VCEK slot key malformed (chip id ${JSON.stringify(chipIdHex)}, TCB ${JSON.stringify(tcbHex2)}): 64-byte and 8-byte lowercase hex are required`);
    const f = file(product, path2.join("vcek", `${safe(chipIdHex)}-${safe(tcbHex2)}.der`));
    const { ask } = await askOf(product);
    const cached = read(f);
    if (cached) {
      const m = meta(f), why2 = vcekWhy(cached, product, ask, chipIdHex, tcbHex2);
      if (!why2 && m && m.sha256 === sha2562(cached)) {
        stats.hits++;
        return { der: cached, source: `cache:${f}`, fetchedAt: m.fetchedAt ?? null, cached: true };
      }
      quarantine(f, why2 || "sidecar missing or its sha256 does not match the bytes");
    } else stats.misses++;
    if (!upstream) return null;
    stats.fetches++;
    const r = await upstream.vcek(product, chipIdHex, tcbHex2, kdsPath);
    if (!r) return null;
    if (!Buffer.isBuffer(r.der)) throw new Error(`VCEK from ${r.source} is not bytes`);
    const why = vcekWhy(r.der, product, ask, chipIdHex, tcbHex2);
    if (why) {
      note("upstream-refused", `${product} VCEK ${chipIdHex.slice(0, 16)} from ${r.source}`, why);
      throw new Error(`VCEK from ${r.source} failed authentication: ${why}`);
    }
    write(f, r.der, { source: r.source ?? null, fetchedAt: r.fetchedAt ?? now().toISOString(), chipId: chipIdHex, tcb: tcbHex2 });
    return { der: r.der, source: r.source ?? "upstream", fetchedAt: r.fetchedAt ?? null, cached: false };
  }
  async function crl(product) {
    const f = file(product, "crl.der");
    const { ark } = await askOf(product);
    const t = now();
    let staleCached = null;
    const cached = read(f);
    if (cached) {
      const m = meta(f), a = checkCrlAuthentic({ crlDer: cached, ark, now: t });
      if (a.ok && m && m.sha256 === sha2562(cached)) {
        const nextUpdate = a.crl.nextUpdate ? a.crl.nextUpdate.toISOString() : null;
        if (!a.crl.nextUpdate || t <= a.crl.nextUpdate) {
          stats.hits++;
          return { der: cached, source: `cache:${f}`, fetchedAt: m.fetchedAt ?? null, cached: true, stale: false, nextUpdate };
        }
        staleCached = { der: cached, source: `cache:${f}`, fetchedAt: m.fetchedAt ?? null, cached: true, stale: true, nextUpdate };
        note("stale", f, `CRL nextUpdate ${nextUpdate} is past; trying the upstream before serving it stale`);
      } else quarantine(f, a.ok ? "sidecar missing or its sha256 does not match the bytes" : a.why);
    } else stats.misses++;
    if (upstream) {
      stats.fetches++;
      let r = null, err = null;
      try {
        r = await upstream.crl(product);
      } catch (e) {
        err = e;
      }
      if (r && Buffer.isBuffer(r.der)) {
        const a = checkCrlAuthentic({ crlDer: r.der, ark, now: t });
        if (!a.ok) {
          note("upstream-refused", `${product} CRL from ${r.source}`, a.why);
          if (!staleCached) throw new Error(`CRL from ${r.source} failed authentication: ${a.why}`);
        } else {
          const nextUpdate = a.crl.nextUpdate ? a.crl.nextUpdate.toISOString() : null, stale = !!(a.crl.nextUpdate && t > a.crl.nextUpdate);
          write(f, r.der, { source: r.source ?? null, fetchedAt: r.fetchedAt ?? t.toISOString() });
          if (stale) stats.staleServed++;
          return { der: r.der, source: r.source ?? "upstream", fetchedAt: r.fetchedAt ?? null, cached: false, stale, nextUpdate };
        }
      } else if (err) note("upstream-failed", `${product} CRL`, err.message);
    }
    if (staleCached) {
      stats.staleServed++;
      note("stale-served", f, "no fresher CRL available; served stale for the policy to judge");
      return staleCached;
    }
    return null;
  }
  return { kind: "cache", dir, events, stats, chain, vcek, crl };
}

// verifier/provenance.mjs
init_dist2();

// verifier/release-policy.json
var release_policy_default = {
  schema: "enclave-release-policy/v1",
  minimumRelease: "v0.5.841",
  revoked: [],
  note: "The release floor and revocation list, in ONE place. The release workflow signs them into every release index (verifier/release-index.mjs, from this file at the tag), and every consumer built from this tree carries this same file as its BUILT-IN policy (verifier/release-policy.mjs, compiled into the Node and browser bundles, whose manifests pin this file's sha256). A consumer applies the highest of the built-in floor, its remembered floor and a verified index's floor; an index whose floor is below the built-in one is refused; revocations only accumulate. Raising minimumRelease or adding to revoked is a reviewed commit that rebuilds the bundles; until a release built from it publishes an index carrying the change, consumers built from it refuse the older index and take their recorded fallback under the new floor. The floor never falls: lowering it is not a supported change."
};

// verifier/release-policy.mjs
var POLICY_SCHEMA = "enclave-release-policy/v1";
var POLICY_FILE_PATH = "verifier/release-policy.json";
var TAG_RE = /^v(\d+)\.(\d+)\.(\d+)(-cpu|-gpu8)?$/;
var parseTag = (tag) => {
  const m = TAG_RE.exec(String(tag || ""));
  return m ? { version: [+m[1], +m[2], +m[3]], flavor: m[4] ? m[4].slice(1) : "gpu" } : null;
};
var versionString = (v) => `v${v.join(".")}`;
var compareVersions = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
function normalizePolicy(p) {
  if (!p || p.schema !== POLICY_SCHEMA) throw new Error(`release policy schema must be ${POLICY_SCHEMA}`);
  const min = parseTag(p.minimumRelease);
  if (!min || min.flavor !== "gpu") throw new Error(`release policy minimumRelease must be a bare vX.Y.Z tag, not ${JSON.stringify(p.minimumRelease)}`);
  const revoked = Array.isArray(p.revoked) ? p.revoked.map(String) : null;
  if (!revoked || revoked.some((t) => !parseTag(t))) throw new Error("release policy revoked must be a list of release tags");
  return { minimumRelease: min.version, revoked };
}
var parsed = normalizePolicy(release_policy_default);
var RELEASE_POLICY = Object.freeze({ minimumRelease: Object.freeze([...parsed.minimumRelease]), revoked: Object.freeze([...parsed.revoked]), source: POLICY_FILE_PATH });
function floorOf({ caller = null, remembered = null, index = null } = {}) {
  const valid = (v) => Array.isArray(v) && v.length === 3 && v.every((n) => Number.isInteger(n) && n >= 0);
  let floor = valid(caller) ? [...caller] : [...RELEASE_POLICY.minimumRelease], source = valid(caller) ? "caller" : "built-in";
  if (valid(remembered) && compareVersions(remembered, floor) >= 0) {
    floor = [...remembered];
    source = "remembered";
  }
  if (valid(index) && compareVersions(index, floor) >= 0) {
    floor = [...index];
    source = "signed index";
  }
  return { floor, source, builtin: [...RELEASE_POLICY.minimumRelease], callerBelowBuiltin: valid(caller) && compareVersions(caller, RELEASE_POLICY.minimumRelease) < 0 };
}
var revokedOf = (...lists) => [.../* @__PURE__ */ new Set([...RELEASE_POLICY.revoked, ...lists.flatMap((l) => Array.isArray(l) ? l.map(String) : [])])];
var floorRecord = (f) => ({ floorApplied: versionString(f.floor), floorSource: f.source, builtinFloor: versionString(f.builtin), ...f.callerBelowBuiltin ? { callerBelowBuiltin: true } : {} });

// verifier/provenance.mjs
var DEFAULT_RELEASE_POLICY = Object.freeze({
  repository: "EnclaveHost/enclave",
  workflowPath: ".github/workflows/tinfoil-release-publish.yml",
  refPattern: "^refs/tags/v(\\d+)\\.(\\d+)\\.(\\d+)(-cpu|-gpu8)?$",
  issuer: GITHUB_OIDC_ISSUER,
  predicateTypes: ["https://tinfoil.sh/predicate/snp-tdx-multiplatform/v1"],
  // [major, minor, patch] and tags, from verifier/release-policy.json (verifier/release-policy.mjs): an older GENUINE release
  // is a rollback and a revoked one is refused by name. A caller may pass its own floor; revocations only accumulate.
  minimumRelease: RELEASE_POLICY.minimumRelease,
  revoked: RELEASE_POLICY.revoked,
  allowedTriggers: ["workflow_dispatch"],
  requireVisibility: "public"
});
var IN_TOTO_STATEMENT_V1 = "https://in-toto.io/Statement/v1";
var ext = (cert, name, key) => {
  const e = cert[name];
  return e ? e[key] : void 0;
};
var Rule = class {
  constructor(name, fn) {
    this.name = name;
    this.fn = fn;
  }
  verify(cert) {
    const why = this.fn(cert);
    if (why) throw new Error(`${this.name}: ${why}`);
  }
};
function releasePolicyRules(pol) {
  const re = new RegExp(pol.refPattern);
  const refOf = (cert) => ext(cert, "extGitHubWorkflowRef", "workflowRef") ?? ext(cert, "extSourceRepositoryRef", "sourceRepositoryRef");
  return new AllOf([
    new OIDCIssuer(pol.issuer),
    new GitHubWorkflowRepository(pol.repository),
    new Rule("tag ref", (c) => {
      const ref = refOf(c);
      return !ref ? "missing workflow ref" : re.test(ref) ? null : `ref ${JSON.stringify(ref)} does not match ${pol.refPattern}`;
    }),
    new Rule("workflow path", (c) => {
      const ref = refOf(c);
      const want = `https://github.com/${pol.repository}/${pol.workflowPath}@${ref}`;
      const got = ext(c, "extBuildConfigURI", "buildConfigURI");
      return got === want ? null : `build config ${JSON.stringify(got)} != ${want}`;
    }),
    new Rule("source repository", (c) => {
      const got = ext(c, "extSourceRepositoryURI", "sourceRepositoryURI");
      return got === `https://github.com/${pol.repository}` ? null : `source repository ${JSON.stringify(got)}`;
    }),
    new Rule("trigger", (c) => {
      const got = ext(c, "extBuildTrigger", "buildTrigger") ?? ext(c, "extGitHubWorkflowTrigger", "workflowTrigger");
      return !pol.allowedTriggers || pol.allowedTriggers.includes(got) ? null : `trigger ${JSON.stringify(got)} not allowed`;
    }),
    new Rule("visibility", (c) => {
      const got = ext(c, "extSourceRepositoryVisibility", "sourceRepositoryVisibility");
      return !pol.requireVisibility || got === pol.requireVisibility ? null : `repository visibility ${JSON.stringify(got)}`;
    })
  ]);
}
async function verifyStatementBundle({ bundle, digestHex, trustedRoot, policy = DEFAULT_RELEASE_POLICY, predicateTypes = null, subjectName = "the release digest" }) {
  const pol = { ...DEFAULT_RELEASE_POLICY, ...policy };
  const allowed = predicateTypes ?? pol.predicateTypes;
  const reasons = [], fail = (m) => ({ ok: false, reasons: [...reasons, `REJECT: ${m}`], statement: null, cert: null });
  if (!bundle || typeof bundle !== "object") return fail("bundle is not an object");
  if (bundle.mediaType !== "application/vnd.dev.sigstore.bundle.v0.3+json") return fail(`bundle mediaType ${JSON.stringify(bundle.mediaType)} is not v0.3 (single-certificate form)`);
  if (bundle.verificationMaterial?.x509CertificateChain) return fail("bundle carries an x509CertificateChain (legacy form) and is refused");
  if (!bundle.verificationMaterial?.certificate?.rawBytes) return fail("bundle has no signing certificate");
  if (!bundle.dsseEnvelope || (bundle.dsseEnvelope.signatures || []).length !== 1) return fail("bundle must carry one DSSE envelope with exactly one signature");
  if (!Array.isArray(bundle.verificationMaterial.tlogEntries) || !bundle.verificationMaterial.tlogEntries.length) return fail("bundle carries no transparency-log entry");
  if (!/^[0-9a-f]{64}$/.test(String(digestHex))) return fail("digest must be 64 hex characters");
  if (!trustedRoot || !Array.isArray(trustedRoot.certificateAuthorities)) return fail("no Sigstore trusted root supplied (it must come from Sigstore's TUF repository, never from the bundle)");
  const verifier = new SigstoreVerifier({ tlogThreshold: 1, ctlogThreshold: 1, tsaThreshold: 0 });
  try {
    await verifier.loadSigstoreRoot(trustedRoot);
  } catch (e) {
    return fail(`trusted root unusable: ${e.message}`);
  }
  let payloadType, payloadBytes;
  try {
    ({ payloadType, payload: payloadBytes } = await verifier.verifyDsse(bundle, releasePolicyRules(pol)));
  } catch (e) {
    return fail(`Sigstore verification failed: ${e.message}`);
  }
  reasons.push(`Sigstore: Fulcio chain to the pinned root, SCT, Rekor inclusion, DSSE signature, and the identity policy (repo ${pol.repository}, workflow ${pol.workflowPath}, tag pattern, issuer ${pol.issuer}, trigger, visibility)`);
  if (payloadType !== "application/vnd.in-toto+json") return fail(`payload type ${payloadType} is not an in-toto statement`);
  let st;
  try {
    st = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return fail("statement is not JSON");
  }
  const extra = Object.keys(st).filter((k) => !["_type", "subject", "predicateType", "predicate"].includes(k));
  if (extra.length) return fail(`statement carries unknown top-level fields ${extra.join(", ")}`);
  if (st._type !== IN_TOTO_STATEMENT_V1) return fail(`statement _type ${JSON.stringify(st._type)} is not ${IN_TOTO_STATEMENT_V1}`);
  if (!Array.isArray(st.subject) || st.subject.length !== 1 || !st.subject[0]?.digest?.sha256) return fail("statement must have exactly one subject with a sha256 digest");
  if (st.subject[0].digest.sha256.toLowerCase() !== digestHex.toLowerCase()) return fail(`statement subject ${st.subject[0].digest.sha256.slice(0, 16)}... is not ${subjectName} ${digestHex.slice(0, 16)}...`);
  if (!allowed.includes(st.predicateType)) return fail(`predicate type ${JSON.stringify(st.predicateType)} is not accepted (${allowed.join(", ")})`);
  const { X509Certificate: X509Certificate6 } = await Promise.resolve().then(() => (init_dist2(), dist_exports));
  const cert = X509Certificate6.parse(Uint8Array.from(Buffer.from(bundle.verificationMaterial.certificate.rawBytes, "base64")));
  return { ok: true, reasons, statement: st, cert, pol };
}
function identityClaimsOf(cert, pol, bundle) {
  const ref = ext(cert, "extGitHubWorkflowRef", "workflowRef");
  const m = new RegExp(pol.refPattern).exec(ref);
  const ver = m ? [+m[1], +m[2], +m[3]] : null, flavor = m ? m[4] ? m[4].slice(1) : "gpu" : null;
  const integratedTime = bundle.verificationMaterial.tlogEntries[0]?.integratedTime;
  return {
    repository: pol.repository,
    ref,
    tag: String(ref || "").replace(/^refs\/tags\//, ""),
    version: ver,
    flavor,
    workflow: ext(cert, "extBuildConfigURI", "buildConfigURI"),
    sha: ext(cert, "extGitHubWorkflowSHA", "workflowSHA") ?? ext(cert, "extSourceRepositoryDigest", "sourceRepositoryDigest"),
    trigger: ext(cert, "extBuildTrigger", "buildTrigger"),
    runInvocation: ext(cert, "extRunInvocationURI", "runInvocationURI"),
    signedAt: cert.notBefore?.toISOString?.() ?? null,
    integratedTime: integratedTime ? new Date(Number(integratedTime) * 1e3).toISOString() : null
  };
}
async function verifyReleaseAttestation({ bundle, digestHex, trustedRoot, policy = DEFAULT_RELEASE_POLICY }) {
  const s = await verifyStatementBundle({ bundle, digestHex, trustedRoot, policy });
  if (!s.ok) return { ok: false, reasons: s.reasons, claims: null };
  const { statement: st, cert, pol } = s;
  const reasons = [...s.reasons], fail = (m) => ({ ok: false, reasons: [...reasons, `REJECT: ${m}`], claims: null });
  const pr = st.predicate || {};
  if (!/^[0-9a-f]{96}$/.test(String(pr.snp_measurement || ""))) return fail("predicate has no 48-byte snp_measurement");
  reasons.push(`in-toto v1 statement: subject ${st.subject[0].name} sha256:${digestHex.slice(0, 16)}..., predicate ${st.predicateType}`);
  const id = identityClaimsOf(cert, pol, bundle);
  if (!id.version) return fail(`ref ${id.ref} did not yield a version`);
  if (compareVersions(id.version, pol.minimumRelease) < 0) return fail(`release v${id.version.join(".")} is below the minimum release v${pol.minimumRelease.join(".")} (a genuine but rolled-back release)`);
  if (RELEASE_POLICY.revoked.includes(id.tag)) return fail(`release ${id.tag} is revoked by the built-in release policy (${RELEASE_POLICY.source})`);
  if (Array.isArray(pol.revoked) && pol.revoked.includes(id.tag)) return fail(`release ${id.tag} is revoked (by the release index or the caller's policy)`);
  reasons.push(`release v${id.version.join(".")} (${id.flavor}) meets the minimum v${pol.minimumRelease.join(".")}`);
  return { ok: true, reasons, claims: {
    ...id,
    digest: digestHex.toLowerCase(),
    snpMeasurement: pr.snp_measurement,
    tdxMeasurement: pr.tdx_measurement ?? null,
    cmdline: pr.cmdline ?? null,
    imageHashes: pr.hashes ?? null,
    configSha256: pr.config ? await sha256HexOf(Buffer.from(pr.config, "base64")) : null
  } };
}
var sha256HexOf = async (bytes2) => Array.from(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes2))).map((b) => b.toString(16).padStart(2, "0")).join("");

// verifier/release-index.mjs
import fs3 from "node:fs";
import path3 from "node:path";
import { fileURLToPath } from "node:url";
import { createHash as createHash3 } from "node:crypto";

// verifier/release-index-core.mjs
var sha256HexOf2 = async (bytes2) => Array.from(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes2))).map((b) => b.toString(16).padStart(2, "0")).join("");
var INDEX_SCHEMA = "enclave-release-index/v2";
var INDEX_SCHEMA_V1 = "enclave-release-index/v1";
var INDEX_SCHEMAS = Object.freeze([INDEX_SCHEMA, INDEX_SCHEMA_V1]);
var INDEX_PREDICATE = "https://enclave.host/predicate/release-index/v1";
var INDEX_ASSET = "release-index.json";
var FLAVORS = Object.freeze(["gpu", "cpu", "gpu8"]);
function buildReleaseIndex({ releases, policy, repository, generatedAt = (/* @__PURE__ */ new Date()).toISOString(), publication = null } = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(repository || ""))) throw new Error("repository must be OWNER/NAME");
  const pub = normalizePublication(publication);
  if (!pub) throw new Error("publication { runId, attempt } is required: the index's order is the signing run's, never a count");
  const pol = normalizePolicy({ schema: POLICY_SCHEMA, minimumRelease: versionString(policy.minimumRelease), revoked: policy.revoked });
  const rows = [];
  for (const r of releases || []) {
    const t = parseTag(r?.tag);
    if (!t) continue;
    if (!/^[0-9a-f]{64}$/.test(String(r.digest || "").toLowerCase())) continue;
    rows.push({
      tag: r.tag,
      digest: String(r.digest).toLowerCase(),
      publishedAt: r.publishedAt ?? null,
      version: t.version,
      flavor: t.flavor,
      revoked: pol.revoked.includes(r.tag),
      belowFloor: compareVersions(t.version, pol.minimumRelease) < 0
    });
  }
  rows.sort((a, b) => compareVersions(b.version, a.version) || a.flavor.localeCompare(b.flavor));
  const latest = {};
  for (const f of FLAVORS) {
    const c = rows.find((r) => r.flavor === f && !r.revoked && !r.belowFloor);
    if (c) latest[f] = { tag: c.tag, digest: c.digest, publishedAt: c.publishedAt };
  }
  return {
    schema: INDEX_SCHEMA,
    repository,
    generatedAt,
    sequence: pub.runId,
    attempt: pub.attempt,
    minimumRelease: versionString(pol.minimumRelease),
    revoked: [...pol.revoked],
    latest,
    releases: rows.map((r) => ({ tag: r.tag, digest: r.digest, publishedAt: r.publishedAt, ...r.revoked ? { revoked: true } : {}, ...r.belowFloor ? { belowFloor: true } : {} }))
  };
}
var indexBytesOf = (index) => Buffer.from(JSON.stringify(index, null, 1) + "\n", "utf8");
var RUN_RE = /\/actions\/runs\/(\d{1,15})\/attempts\/(\d{1,6})$/;
function normalizePublication(p) {
  if (!p) return null;
  const runId = Number(p.runId), attempt = Number(p.attempt);
  if (!Number.isSafeInteger(runId) || runId <= 0 || !Number.isSafeInteger(attempt) || attempt <= 0) return null;
  return { runId, attempt };
}
function publicationOf(runInvocation) {
  const m = RUN_RE.exec(String(runInvocation || ""));
  return m ? { runId: Number(m[1]), attempt: Number(m[2]), uri: String(runInvocation) } : null;
}
function checkIndex({ index, digestHex, predicate, policy = DEFAULT_RELEASE_POLICY, publication = null }) {
  const pol = { ...DEFAULT_RELEASE_POLICY, ...policy };
  const reasons = [], fail = (m) => ({ ok: false, reasons: [...reasons, `REJECT: ${m}`] });
  if (!index || typeof index !== "object") return fail("index is not an object");
  if (!INDEX_SCHEMAS.includes(index.schema)) return fail(`index schema ${JSON.stringify(index.schema)} is not ${INDEX_SCHEMA} (or the first index's ${INDEX_SCHEMA_V1})`);
  const pub = normalizePublication(publication);
  if (!pub) return fail("the signing certificate names no run invocation: the index cannot be ordered, so it is not accepted");
  let sequenceAuthenticated = false;
  if (index.schema === INDEX_SCHEMA) {
    if (index.sequence !== pub.runId || index.attempt !== pub.attempt) return fail(`the index names publication run ${index.sequence} attempt ${index.attempt}, the signing certificate says run ${pub.runId} attempt ${pub.attempt}`);
    if (predicate && predicate.attempt !== index.attempt) return fail("the predicate and the index disagree (attempt)");
    sequenceAuthenticated = true;
  } else reasons.push(`index schema v1: its sequence ${index.sequence} is a bounded count, NOT an order; ordered by the signing run ${pub.runId} attempt ${pub.attempt} alone`);
  if (index.repository !== pol.repository) return fail(`index names repository ${JSON.stringify(index.repository)}, the policy's is ${pol.repository}`);
  if (!predicate || predicate.schema !== INDEX_PREDICATE) return fail("the statement's predicate is not a release-index predicate");
  if (String(predicate.indexSha256 || "").toLowerCase() !== String(digestHex).toLowerCase()) return fail("the predicate's indexSha256 is not the digest of these index bytes");
  if (predicate.repository !== index.repository || predicate.sequence !== index.sequence || predicate.minimumRelease !== index.minimumRelease) return fail("the predicate and the index disagree (repository, sequence or minimumRelease)");
  const min = parseTag(index.minimumRelease);
  if (!min || min.flavor !== "gpu") return fail(`index minimumRelease ${JSON.stringify(index.minimumRelease)} is not a bare vX.Y.Z tag`);
  if (compareVersions(min.version, pol.minimumRelease) < 0) return fail(`index floor ${index.minimumRelease} is BELOW this verifier's built-in floor ${versionString(pol.minimumRelease)}: the floor only rises`);
  if (!Number.isInteger(index.sequence) || index.sequence < 0) return fail("index sequence must be a non-negative integer");
  const gen = Date.parse(index.generatedAt);
  if (!Number.isFinite(gen)) return fail("index generatedAt is not a date");
  if (!Array.isArray(index.revoked) || index.revoked.some((t) => !parseTag(t))) return fail("index revoked must be a list of release tags");
  if (!index.latest || typeof index.latest !== "object") return fail("index has no latest pointers");
  const latest = {};
  for (const [f, e] of Object.entries(index.latest)) {
    if (!FLAVORS.includes(f)) return fail(`index latest names an unknown flavor ${JSON.stringify(f)}`);
    const t = parseTag(e?.tag);
    if (!t || t.flavor !== f) return fail(`index latest.${f} tag ${JSON.stringify(e?.tag)} is not a ${f} release tag`);
    if (!/^[0-9a-f]{64}$/.test(String(e.digest || ""))) return fail(`index latest.${f} carries no sha256 digest`);
    if (index.revoked.includes(e.tag)) return fail(`index latest.${f} points at a revoked release ${e.tag}`);
    if (compareVersions(t.version, min.version) < 0) return fail(`index latest.${f} ${e.tag} is below the index's own floor ${index.minimumRelease}`);
    latest[f] = { tag: e.tag, digest: e.digest.toLowerCase(), version: t.version };
  }
  if (!Object.keys(latest).length) return fail("index points at no release at all");
  reasons.push(`release index of ${index.generatedAt.slice(0, 19)}Z (run ${pub.runId} attempt ${pub.attempt}): floor ${index.minimumRelease}, latest ${Object.values(latest).map((l) => l.tag).join(", ")}${index.revoked.length ? `, revoked ${index.revoked.join(", ")}` : ""}`);
  return { ok: true, reasons, latest, minimumRelease: min.version, revoked: [...index.revoked], sequence: index.sequence, generatedAt: index.generatedAt, publication: pub, sequenceAuthenticated, schema: index.schema };
}
async function verifyReleaseIndex({ indexBytes, bundle, trustedRoot, policy = DEFAULT_RELEASE_POLICY }) {
  const digestHex = await sha256HexOf2(indexBytes);
  const s = await verifyStatementBundle({ bundle, digestHex, trustedRoot, policy, predicateTypes: [INDEX_PREDICATE], subjectName: "the index digest" });
  if (!s.ok) return { ok: false, signed: false, reasons: s.reasons, index: null, claims: null, digest: digestHex };
  let index;
  try {
    index = JSON.parse(Buffer.from(indexBytes).toString("utf8"));
  } catch {
    return { ok: false, signed: true, reasons: [...s.reasons, "REJECT: the index bytes are not JSON"], index: null, claims: null, digest: digestHex };
  }
  const claims = identityClaimsOf(s.cert, s.pol, bundle);
  const publication = publicationOf(claims.runInvocation);
  const c = checkIndex({ index, digestHex, predicate: s.statement.predicate, policy, publication });
  if (!c.ok) return { ok: false, signed: true, reasons: [...s.reasons, ...c.reasons], index, claims, digest: digestHex, publication };
  return {
    ok: true,
    signed: true,
    reasons: [...s.reasons, ...c.reasons],
    index,
    claims,
    digest: digestHex,
    latest: c.latest,
    minimumRelease: c.minimumRelease,
    revoked: c.revoked,
    sequence: c.sequence,
    generatedAt: c.generatedAt,
    publication,
    sequenceAuthenticated: c.sequenceAuthenticated,
    schema: c.schema
  };
}
var candidatesFromIndex = (v) => Object.values(v.latest || {}).map((l) => ({ tag: l.tag, digest: l.digest }));

// verifier/release-index.mjs
var sha256hex = (b) => createHash3("sha256").update(b).digest("hex");
var REPO = path3.resolve(path3.dirname(fileURLToPath(import.meta.url)), "..");
function readReleasePolicy(file = path3.join(REPO, "verifier", "release-policy.json")) {
  const p = JSON.parse(fs3.readFileSync(file, "utf8"));
  return normalizePolicy(p);
}
var indexPredicateOf = (indexBytes, index) => ({ schema: INDEX_PREDICATE, indexSha256: sha256hex(indexBytes), repository: index.repository, generatedAt: index.generatedAt, sequence: index.sequence, ...index.attempt !== void 0 ? { attempt: index.attempt } : {}, minimumRelease: index.minimumRelease, latest: index.latest });
async function main() {
  const args = process.argv.slice(2), cmd = args.shift();
  const opt = (n, d = null) => {
    const i = args.indexOf("--" + n);
    return i >= 0 ? args[i + 1] : d;
  };
  const die = (m) => {
    console.error(`release-index: ${m}`);
    process.exit(2);
  };
  if (cmd === "build") {
    const repo = opt("repo") || process.env.GITHUB_REPOSITORY || die("--repo OWNER/NAME"), out = opt("out") || die("--out F"), limit = Number(opt("limit", "20"));
    const policy = readReleasePolicy(opt("policy") || void 0);
    const headers = { accept: "application/vnd.github+json", "user-agent": "enclave-release-index", ...process.env.GH_TOKEN || process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN || process.env.GITHUB_TOKEN}` } : {} };
    const get = async (url, accept) => {
      const r = await fetch(url, { headers: { ...headers, ...accept ? { accept } : {} }, signal: AbortSignal.timeout(2e4), redirect: "follow" });
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    };
    const list = JSON.parse((await get(`https://api.github.com/repos/${repo}/releases?per_page=100`)).toString("utf8")).filter((r) => !r.draft && parseTag(r.tag_name));
    list.sort((a, b) => compareVersions(parseTag(b.tag_name).version, parseTag(a.tag_name).version));
    const releases = [];
    for (const r of list.slice(0, limit)) {
      const asset = (r.assets || []).find((a) => a.name === "tinfoil.hash");
      if (!asset) {
        console.error(`release-index: ${r.tag_name}: no tinfoil.hash asset, listed without a digest`);
        continue;
      }
      let digest = null;
      try {
        digest = (await get(asset.browser_download_url, "application/octet-stream")).toString("utf8").trim().toLowerCase();
      } catch (e) {
        console.error(`release-index: ${r.tag_name}: ${e.message}`);
        continue;
      }
      releases.push({ tag: r.tag_name, digest, publishedAt: r.published_at });
    }
    const publication = normalizePublication({ runId: opt("run-id") ?? process.env.GITHUB_RUN_ID, attempt: opt("run-attempt") ?? process.env.GITHUB_RUN_ATTEMPT });
    if (!publication) die("--run-id/--run-attempt (or GITHUB_RUN_ID/GITHUB_RUN_ATTEMPT) are required: the index's order is the signing run's, never a count");
    const index = buildReleaseIndex({ releases, policy, repository: repo, publication });
    const bytes2 = indexBytesOf(index);
    fs3.writeFileSync(out, bytes2);
    if (opt("predicate")) fs3.writeFileSync(opt("predicate"), JSON.stringify(indexPredicateOf(bytes2, index), null, 1) + "\n");
    console.log(`release index: run ${index.sequence} attempt ${index.attempt}; ${releases.length} release(s) with digests of ${list.length}; floor ${index.minimumRelease}; latest ${JSON.stringify(index.latest)}; sha256 ${sha256hex(bytes2)} -> ${out}`);
    return;
  }
  if (cmd === "verify") {
    const indexBytes = fs3.readFileSync(opt("index") || die("--index F"));
    const j = JSON.parse(fs3.readFileSync(opt("bundle") || die("--bundle F"), "utf8"));
    const bundle = j.attestations ? j.attestations[0]?.bundle : j;
    const trustedRoot = JSON.parse(fs3.readFileSync(opt("trusted-root") || path3.join(REPO, "verifier", "roots", "sigstore-trusted-root.json"), "utf8"));
    const r = await verifyReleaseIndex({ indexBytes, bundle, trustedRoot, policy: opt("repo") ? { repository: opt("repo") } : void 0 });
    if (args.includes("--json")) console.log(JSON.stringify(r, null, 2));
    else {
      for (const x of r.reasons) console.log(x);
      console.log(r.ok ? `VERIFIED release index: publication run ${r.publication.runId} attempt ${r.publication.attempt} (floor ${versionString(r.minimumRelease)}${r.sequenceAuthenticated ? "" : "; schema v1, ordered by the certificate alone"})` : "REFUSED");
    }
    process.exit(r.ok ? 0 : 1);
  }
  die("usage: release-index.mjs build|verify ...");
}
if (process.argv[1] && path3.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => {
  console.error(`release-index: ${e.message}`);
  process.exit(2);
});

// verifier/index-memory-file.mjs
import fs4 from "node:fs";
import path4 from "node:path";

// verifier/index-memory.mjs
var memoryStore = () => {
  let v = null;
  return { name: "memory", load: () => v, save: (o) => {
    v = o;
    return true;
  } };
};
function webStorageStore(storage, key = "enclave.verifierIndexMemory") {
  return {
    name: `storage:${key}`,
    load: () => {
      try {
        const raw = storage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    },
    save: (o) => {
      try {
        storage.setItem(key, JSON.stringify(o));
        return true;
      } catch {
        return false;
      }
    }
  };
}
var cmpVersion = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
var cmpPub = (a, b) => a.runId - b.runId || a.attempt - b.attempt;
var validPub = (p) => p && Number.isSafeInteger(p.runId) && p.runId > 0 && Number.isSafeInteger(p.attempt) && p.attempt > 0;
var validVersion = (v) => Array.isArray(v) && v.length === 3 && v.every((n) => Number.isInteger(n) && n >= 0);
function createIndexMemory({ store = null, now = () => /* @__PURE__ */ new Date(), log = () => {
} } = {}) {
  const st = store ?? memoryStore();
  let state = null, note = null, durable = false;
  try {
    const raw = st.load();
    if (raw === null || raw === void 0) {
    } else if (raw && raw.schema === "enclave-index-memory/v1" && validPub(raw.publication) && /^[0-9a-f]{64}$/.test(String(raw.digest || "")) && validVersion(raw.minimumRelease)) {
      state = raw;
      durable = true;
    } else {
      note = `the index memory at ${st.name} is not a record this version understands; starting without one`;
      log(note);
    }
  } catch (e) {
    note = `the index memory at ${st.name} is unreadable (${e.message}); starting without one`;
    log(note);
  }
  const persist = () => {
    let ok = false;
    try {
      ok = st.save(state) === true;
    } catch (e) {
      log(`the index memory could not be written to ${st.name}: ${e.message}`);
      ok = false;
    }
    if (!ok) log(`the index memory could not be written to ${st.name}`);
    durable = ok;
    return ok;
  };
  const remember = (rec) => {
    state = { schema: "enclave-index-memory/v1", ...rec, at: now().toISOString() };
    return persist();
  };
  function consider({ publication, digest, minimumRelease, tag = null } = {}) {
    if (!validPub(publication)) return { ok: false, kind: "invalid", why: "no publication (run id and attempt) to order by", remembered: state };
    if (!/^[0-9a-f]{64}$/.test(String(digest || ""))) return { ok: false, kind: "invalid", why: "no digest to remember", remembered: state };
    if (!validVersion(minimumRelease)) return { ok: false, kind: "invalid", why: "no floor to remember", remembered: state };
    const rec = { publication: { runId: publication.runId, attempt: publication.attempt }, digest: String(digest).toLowerCase(), minimumRelease: [...minimumRelease], tag };
    if (!state) {
      const persisted2 = remember(rec);
      return { ok: true, kind: "first-seen", why: `first index remembered: run ${rec.publication.runId} attempt ${rec.publication.attempt}`, persisted: persisted2, remembered: state };
    }
    const c = cmpPub(rec.publication, state.publication);
    const seen = `run ${state.publication.runId} attempt ${state.publication.attempt}${state.tag ? ` (${state.tag})` : ""}`;
    if (c < 0) return { ok: false, kind: "replay", why: `replay: publication run ${rec.publication.runId} attempt ${rec.publication.attempt} is older than the remembered ${seen}`, remembered: state };
    if (c === 0) {
      if (state.equivocation) return { ok: false, kind: "equivocation", why: `equivocation: publication ${seen} was verified with digest ${state.digest.slice(0, 16)}... and later seen with ${state.equivocation.digest.slice(0, 16)}...; nothing from it is taken (these bytes: ${rec.digest.slice(0, 16)}...)`, persisted: durable, remembered: state };
      if (rec.digest === state.digest) return { ok: true, kind: "same", why: `the remembered publication ${seen}, same bytes`, persisted: durable, remembered: state };
      const persisted2 = remember({ ...state, equivocation: { digest: rec.digest, tag, seenAt: now().toISOString() } });
      return { ok: false, kind: "equivocation", why: `equivocation: publication ${seen} was verified with digest ${state.digest.slice(0, 16)}..., these bytes are ${rec.digest.slice(0, 16)}...; nothing from either is taken`, persisted: persisted2, remembered: state };
    }
    if (state.equivocation) {
      log(`index memory: publication ${seen} had equivocated; superseded by run ${rec.publication.runId} attempt ${rec.publication.attempt}`);
    }
    if (cmpVersion(rec.minimumRelease, state.minimumRelease) < 0) return { ok: false, kind: "floor-regression", why: `floor regression: the remembered floor v${state.minimumRelease.join(".")} is above this index's v${rec.minimumRelease.join(".")}`, remembered: state };
    const persisted = remember(rec);
    return { ok: true, kind: "newest-seen", why: `newer publication: run ${rec.publication.runId} attempt ${rec.publication.attempt} after ${seen}`, persisted, remembered: state };
  }
  return { consider, floor: () => state ? [...state.minimumRelease] : null, record: () => state ? structuredClone(state) : null, note: () => note, durable: () => durable, file: st.file ?? null, store: st.name };
}

// verifier/index-memory-file.mjs
function fileStore(file) {
  return {
    name: file,
    file,
    load: () => {
      try {
        return JSON.parse(fs4.readFileSync(file, "utf8"));
      } catch (e) {
        if (e.code === "ENOENT") return null;
        throw e;
      }
    },
    save: (o) => {
      try {
        fs4.mkdirSync(path4.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
        fs4.writeFileSync(tmp, JSON.stringify(o, null, 1) + "\n");
        fs4.renameSync(tmp, file);
        return true;
      } catch {
        return false;
      }
    }
  };
}
var createFileIndexMemory = ({ file = null, store = null, ...rest } = {}) => createIndexMemory({ store: store ?? (file ? fileStore(file) : null), ...rest });

// verifier/roots/sigstore-trusted-root.json
var sigstore_trusted_root_default = {
  mediaType: "application/vnd.dev.sigstore.trustedroot+json;version=0.1",
  tlogs: [
    {
      baseUrl: "https://rekor.sigstore.dev",
      hashAlgorithm: "SHA2_256",
      publicKey: {
        rawBytes: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE2G2Y+2tabdTV5BcGiBIx0a9fAFwrkBbmLSGtks4L3qX6yYY0zufBnhC8Ur/iy55GhWP/9A/bY2LhC30M9+RYtw==",
        keyDetails: "PKIX_ECDSA_P256_SHA_256",
        validFor: {
          start: "2021-01-12T11:53:27Z"
        }
      },
      logId: {
        keyId: "wNI9atQGlz+VWfO6LRygH4QUfY/8W4RFwiT5i5WRgB0="
      }
    },
    {
      baseUrl: "https://log2025-1.rekor.sigstore.dev",
      hashAlgorithm: "SHA2_256",
      publicKey: {
        rawBytes: "MCowBQYDK2VwAyEAt8rlp1knGwjfbcXAYPYAkn0XiLz1x8O4t0YkEhie244=",
        keyDetails: "PKIX_ED25519",
        validFor: {
          start: "2025-09-23T00:00:00Z"
        }
      },
      logId: {
        keyId: "zxGZFVvd0FEmjR8WrFwMdcAJ9vtaY/QXf44Y1wUeP6A="
      }
    }
  ],
  certificateAuthorities: [
    {
      subject: {
        organization: "sigstore.dev",
        commonName: "sigstore"
      },
      uri: "https://fulcio.sigstore.dev",
      certChain: {
        certificates: [
          {
            rawBytes: "MIIB+DCCAX6gAwIBAgITNVkDZoCiofPDsy7dfm6geLbuhzAKBggqhkjOPQQDAzAqMRUwEwYDVQQKEwxzaWdzdG9yZS5kZXYxETAPBgNVBAMTCHNpZ3N0b3JlMB4XDTIxMDMwNzAzMjAyOVoXDTMxMDIyMzAzMjAyOVowKjEVMBMGA1UEChMMc2lnc3RvcmUuZGV2MREwDwYDVQQDEwhzaWdzdG9yZTB2MBAGByqGSM49AgEGBSuBBAAiA2IABLSyA7Ii5k+pNO8ZEWY0ylemWDowOkNa3kL+GZE5Z5GWehL9/A9bRNA3RbrsZ5i0JcastaRL7Sp5fp/jD5dxqc/UdTVnlvS16an+2Yfswe/QuLolRUCrcOE2+2iA5+tzd6NmMGQwDgYDVR0PAQH/BAQDAgEGMBIGA1UdEwEB/wQIMAYBAf8CAQEwHQYDVR0OBBYEFMjFHQBBmiQpMlEk6w2uSu1KBtPsMB8GA1UdIwQYMBaAFMjFHQBBmiQpMlEk6w2uSu1KBtPsMAoGCCqGSM49BAMDA2gAMGUCMH8liWJfMui6vXXBhjDgY4MwslmN/TJxVe/83WrFomwmNf056y1X48F9c4m3a3ozXAIxAKjRay5/aj/jsKKGIkmQatjI8uupHr/+CxFvaJWmpYqNkLDGRU+9orzh5hI2RrcuaQ=="
          }
        ]
      },
      validFor: {
        start: "2021-03-07T03:20:29Z",
        end: "2022-12-31T23:59:59.999Z"
      }
    },
    {
      subject: {
        organization: "sigstore.dev",
        commonName: "sigstore"
      },
      uri: "https://fulcio.sigstore.dev",
      certChain: {
        certificates: [
          {
            rawBytes: "MIICGjCCAaGgAwIBAgIUALnViVfnU0brJasmRkHrn/UnfaQwCgYIKoZIzj0EAwMwKjEVMBMGA1UEChMMc2lnc3RvcmUuZGV2MREwDwYDVQQDEwhzaWdzdG9yZTAeFw0yMjA0MTMyMDA2MTVaFw0zMTEwMDUxMzU2NThaMDcxFTATBgNVBAoTDHNpZ3N0b3JlLmRldjEeMBwGA1UEAxMVc2lnc3RvcmUtaW50ZXJtZWRpYXRlMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAE8RVS/ysH+NOvuDZyPIZtilgUF9NlarYpAd9HP1vBBH1U5CV77LSS7s0ZiH4nE7Hv7ptS6LvvR/STk798LVgMzLlJ4HeIfF3tHSaexLcYpSASr1kS0N/RgBJz/9jWCiXno3sweTAOBgNVHQ8BAf8EBAMCAQYwEwYDVR0lBAwwCgYIKwYBBQUHAwMwEgYDVR0TAQH/BAgwBgEB/wIBADAdBgNVHQ4EFgQU39Ppz1YkEZb5qNjpKFWixi4YZD8wHwYDVR0jBBgwFoAUWMAeX5FFpWapesyQoZMi0CrFxfowCgYIKoZIzj0EAwMDZwAwZAIwPCsQK4DYiZYDPIaDi5HFKnfxXx6ASSVmERfsynYBiX2X6SJRnZU84/9DZdnFvvxmAjBOt6QpBlc4J/0DxvkTCqpclvziL6BCCPnjdlIB3Pu3BxsPmygUY7Ii2zbdCdliiow="
          },
          {
            rawBytes: "MIIB9zCCAXygAwIBAgIUALZNAPFdxHPwjeDloDwyYChAO/4wCgYIKoZIzj0EAwMwKjEVMBMGA1UEChMMc2lnc3RvcmUuZGV2MREwDwYDVQQDEwhzaWdzdG9yZTAeFw0yMTEwMDcxMzU2NTlaFw0zMTEwMDUxMzU2NThaMCoxFTATBgNVBAoTDHNpZ3N0b3JlLmRldjERMA8GA1UEAxMIc2lnc3RvcmUwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAAT7XeFT4rb3PQGwS4IajtLk3/OlnpgangaBclYpsYBr5i+4ynB07ceb3LP0OIOZdxexX69c5iVuyJRQ+Hz05yi+UF3uBWAlHpiS5sh0+H2GHE7SXrk1EC5m1Tr19L9gg92jYzBhMA4GA1UdDwEB/wQEAwIBBjAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQWBBRYwB5fkUWlZql6zJChkyLQKsXF+jAfBgNVHSMEGDAWgBRYwB5fkUWlZql6zJChkyLQKsXF+jAKBggqhkjOPQQDAwNpADBmAjEAj1nHeXZp+13NWBNa+EDsDP8G1WWg1tCMWP/WHPqpaVo0jhsweNFZgSs0eE7wYI4qAjEA2WB9ot98sIkoF3vZYdd3/VtWB5b9TNMea7Ix/stJ5TfcLLeABLE4BNJOsQ4vnBHJ"
          }
        ]
      },
      validFor: {
        start: "2022-04-13T20:06:15Z"
      }
    }
  ],
  ctlogs: [
    {
      baseUrl: "https://ctfe.sigstore.dev/test",
      hashAlgorithm: "SHA2_256",
      publicKey: {
        rawBytes: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEbfwR+RJudXscgRBRpKX1XFDy3PyudDxz/SfnRi1fT8ekpfBd2O1uoz7jr3Z8nKzxA69EUQ+eFCFI3zeubPWU7w==",
        keyDetails: "PKIX_ECDSA_P256_SHA_256",
        validFor: {
          start: "2021-03-14T00:00:00Z",
          end: "2022-10-31T23:59:59.999Z"
        }
      },
      logId: {
        keyId: "CGCS8ChS/2hF0dFrJ4ScRWcYrBY9wzjSbea8IgY2b3I="
      }
    },
    {
      baseUrl: "https://ctfe.sigstore.dev/2022",
      hashAlgorithm: "SHA2_256",
      publicKey: {
        rawBytes: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEiPSlFi0CmFTfEjCUqF9HuCEcYXNKAaYalIJmBZ8yyezPjTqhxrKBpMnaocVtLJBI1eM3uXnQzQGAJdJ4gs9Fyw==",
        keyDetails: "PKIX_ECDSA_P256_SHA_256",
        validFor: {
          start: "2022-10-20T00:00:00Z"
        }
      },
      logId: {
        keyId: "3T0wasbHETJjGR4cmWc3AqJKXrjePK3/h4pygC8p7o4="
      }
    }
  ],
  timestampAuthorities: [
    {
      subject: {
        organization: "sigstore.dev",
        commonName: "sigstore-tsa-selfsigned"
      },
      uri: "https://timestamp.sigstore.dev/api/v1/timestamp",
      certChain: {
        certificates: [
          {
            rawBytes: "MIICEDCCAZagAwIBAgIUOhNULwyQYe68wUMvy4qOiyojiwwwCgYIKoZIzj0EAwMwOTEVMBMGA1UEChMMc2lnc3RvcmUuZGV2MSAwHgYDVQQDExdzaWdzdG9yZS10c2Etc2VsZnNpZ25lZDAeFw0yNTA0MDgwNjU5NDNaFw0zNTA0MDYwNjU5NDNaMC4xFTATBgNVBAoTDHNpZ3N0b3JlLmRldjEVMBMGA1UEAxMMc2lnc3RvcmUtdHNhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAE4ra2Z8hKNig2T9kFjCAToGG30jky+WQv3BzL+mKvh1SKNR/UwuwsfNCg4sryoYAd8E6isovVA3M4aoNdm9QDi50Z8nTEyvqgfDPtTIwXItfiW/AFf1V7uwkbkAoj0xxco2owaDAOBgNVHQ8BAf8EBAMCB4AwHQYDVR0OBBYEFIn9eUOHz9BlRsMCRscsc1t9tOsDMB8GA1UdIwQYMBaAFJjsAe9/u1H/1JUeb4qImFMHic6/MBYGA1UdJQEB/wQMMAoGCCsGAQUFBwMIMAoGCCqGSM49BAMDA2gAMGUCMDtpsV/6KaO0qyF/UMsX2aSUXKQFdoGTptQGc0ftq1csulHPGG6dsmyMNd3JB+G3EQIxAOajvBcjpJmKb4Nv+2Taoj8Uc5+b6ih6FXCCKraSqupe07zqswMcXJTe1cExvHvvlw=="
          },
          {
            rawBytes: "MIIB9zCCAXygAwIBAgIUV7f0GLDOoEzIh8LXSW80OJiUp14wCgYIKoZIzj0EAwMwOTEVMBMGA1UEChMMc2lnc3RvcmUuZGV2MSAwHgYDVQQDExdzaWdzdG9yZS10c2Etc2VsZnNpZ25lZDAeFw0yNTA0MDgwNjU5NDNaFw0zNTA0MDYwNjU5NDNaMDkxFTATBgNVBAoTDHNpZ3N0b3JlLmRldjEgMB4GA1UEAxMXc2lnc3RvcmUtdHNhLXNlbGZzaWduZWQwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAAQUQNtfRT/ou3YATa6wB/kKTe70cfJwyRIBovMnt8RcJph/COE82uyS6FmppLLL1VBPGcPfpQPYJNXzWwi8icwhKQ6W/Qe2h3oebBb2FHpwNJDqo+TMaC/tdfkv/ElJB72jRTBDMA4GA1UdDwEB/wQEAwIBBjASBgNVHRMBAf8ECDAGAQH/AgEAMB0GA1UdDgQWBBSY7AHvf7tR/9SVHm+KiJhTB4nOvzAKBggqhkjOPQQDAwNpADBmAjEAwGEGrfGZR1cen1R8/DTVMI943LssZmJRtDp/i7SfGHmGRP6gRbuj9vOK3b67Z0QQAjEAuT2H673LQEaHTcyQSZrkp4mX7WwkmF+sVbkYY5mXN+RMH13KUEHHOqASaemYWK/E"
          }
        ]
      },
      validFor: {
        start: "2025-07-04T00:00:00Z"
      }
    }
  ]
};

// verifier/consumer.mjs
async function verifyGuestDomainEvidence(doc, { policy = {}, context = {}, collateral = null } = {}) {
  let env;
  try {
    env = parseEnvelope(doc);
  } catch (e) {
    if (!(e instanceof EnvelopeError)) throw e;
    return {
      status: e.code === "unsupported" ? "unsupported" : "rejected",
      admissionSafe: false,
      omissions: [],
      technology: FORMATS[doc?.format]?.technology ?? null,
      reasons: [`${e.code.toUpperCase()}: ${e.message}`],
      checks: {},
      claims: null
    };
  }
  if (env.spec.technology !== TECH.SNP || env.format !== "sev-snp-guest-domain-v1")
    return { status: "unsupported", admissionSafe: false, omissions: [], technology: env.spec.technology, reasons: [`UNSUPPORTED: a release document is sev-snp-guest-domain-v1, not ${env.format}`], checks: {}, claims: null };
  return { technology: env.spec.technology, ...await verifySnp(env, policy.snp || {}, context, collateral) };
}
async function prewarmSnpCollateral(doc, collateral) {
  if (!collateral) return { ok: true, skipped: "no collateral adapter" };
  let p;
  try {
    p = parseReportStrict(parseEnvelope(doc).body);
  } catch {
    return { ok: true, skipped: "unparseable (the verifier refuses it)" };
  }
  const product = p.productHint;
  if (!product) return { ok: true, skipped: "the report names no product line (the verifier refuses it)" };
  const missing = [];
  try {
    const v = await collateral.vcek(product, hex2(p.chipId), hex2(p.reportedTcb), kdsVcekUrl(product, p).replace(/^https:\/\/[^/]+\//, ""));
    if (!v || !v.der) missing.push("vcek");
  } catch (e) {
    missing.push(`vcek (${e.message})`);
  }
  try {
    const c = await collateral.chain(product);
    if (!c || !c.pem) missing.push("chain");
  } catch (e) {
    missing.push(`chain (${e.message})`);
  }
  if (typeof collateral.crl === "function") {
    try {
      const c = await collateral.crl(product);
      if (!c || !c.der) missing.push("crl");
      else if (c.stale === true) missing.push("crl (stale)");
    } catch (e) {
      missing.push(`crl (${e.message})`);
    }
  }
  return missing.length ? { ok: false, product, missing } : { ok: true, product };
}
var RAD_PATH = "/.well-known/tinfoil-attestation";
var DEFAULT_REPO = DEFAULT_RELEASE_POLICY.repository;
var FLAVOR_SUFFIXES = Object.freeze(["", "-cpu", "-gpu8"]);
var TRUSTED_ROOT = sigstore_trusted_root_default;
var USER_AGENT = "enclave-verifier";
var GITHUB_API = "https://api.github.com";
var GITHUB_DOWNLOADS = "https://github.com";
var hex2 = (b) => Buffer.from(b).toString("hex");
var sha256hex2 = (b) => createHash4("sha256").update(b).digest("hex");
var TAG_RE2 = /^v\d+\.\d+\.\d+$/;
async function fetchBounded(url, { fetchImpl = globalThis.fetch, timeoutMs = 2e4, maxBytes = 4 * 1024 * 1024, accept = "application/json" } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { signal: ctrl.signal, headers: { accept, "user-agent": USER_AGENT }, redirect: "follow" });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    const chunks = [];
    let seen = 0;
    for await (const c of r.body ?? []) {
      seen += c.length;
      if (seen > maxBytes) {
        ctrl.abort();
        throw new Error(`${url}: body exceeds ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(c));
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(t);
  }
}
async function releaseExpectationsFrom(candidates, { repo = DEFAULT_REPO, trustedRoot = TRUSTED_ROOT, policy = {}, latestTag = null, keepArtifacts = false } = {}) {
  const out = { repo, latestTag, candidates: [], allowed: [], ok: false, reasons: [], ...keepArtifacts ? { artifacts: { releases: [] } } : {} };
  for (const c of candidates || []) {
    const tag = String(c?.tag ?? "");
    if (!c || c.error || !c.bundle) {
      out.candidates.push({ tag, digest: c?.digest ?? null, provenance: "unavailable", why: c?.error || c?.note || "no attestation bundle" });
      continue;
    }
    const digest = String(c.digest || "").trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(digest)) {
      out.candidates.push({ tag, digest: c.digest ?? null, provenance: "refused", why: "the release digest is not 64 hex characters" });
      continue;
    }
    if (revokedOf(policy.revoked).includes(tag)) {
      out.candidates.push({ tag, digest, provenance: "refused", why: `revoked (${RELEASE_POLICY.revoked.includes(tag) ? `the built-in policy, ${RELEASE_POLICY.source}` : "by the signed release index or the caller's policy"})` });
      continue;
    }
    const r = await verifyReleaseAttestation({ bundle: c.bundle, digestHex: digest, trustedRoot, policy: { ...policy, repository: repo } });
    out.candidates.push({
      tag,
      digest,
      provenance: r.ok ? "verified" : "refused",
      measurement: r.ok ? r.claims.snpMeasurement : null,
      version: r.ok ? r.claims.version : null,
      flavor: r.ok ? r.claims.flavor : null,
      reasons: r.reasons.slice(-2)
    });
    if (r.ok) out.allowed.push({ tag, measurement: r.claims.snpMeasurement, version: r.claims.version, flavor: r.claims.flavor, digest });
    if (r.ok && keepArtifacts) out.artifacts.releases.push({ tag, digest, bundle: c.bundle });
  }
  out.ok = out.allowed.length > 0;
  out.reasons.push(out.ok ? `${out.allowed.length} release(s) with verified provenance: ${out.allowed.map((a) => a.tag).join(", ")}` : "no release's provenance verified: there is no expected measurement, so nothing can be verified (fail closed)");
  return out;
}
async function releaseExpectations({
  repo = DEFAULT_REPO,
  tags = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = 2e4,
  maxBytes = 4 * 1024 * 1024,
  apiBase = GITHUB_API,
  downloadBase = GITHUB_DOWNLOADS,
  trustedRoot = TRUSTED_ROOT,
  policy = {},
  useIndex = true,
  requireIndex = false,
  indexMemory = null,
  keepArtifacts = false
} = {}) {
  let indexArtifact = null;
  const get = (url, accept) => fetchBounded(url, { fetchImpl, timeoutMs, maxBytes, accept });
  let latestTag = null, list = tags, index = { status: "not-consulted" };
  const callerFloor = Array.isArray(policy.minimumRelease) ? policy.minimumRelease : null;
  const remembered = indexMemory?.floor?.() ?? null;
  let floor = floorOf({ caller: callerFloor, remembered });
  let pol = { ...policy, minimumRelease: floor.floor, revoked: revokedOf(policy.revoked) };
  if (!list && useIndex) {
    try {
      const bytes2 = await get(`${downloadBase}/${repo}/releases/latest/download/${INDEX_ASSET}`, "application/json");
      const digest = sha256hex2(bytes2);
      const att = JSON.parse((await get(`${apiBase}/repos/${repo}/attestations/sha256:${digest}`)).toString("utf8"));
      const bundle = att?.attestations?.[0]?.bundle ?? null;
      if (!bundle) index = { status: "unavailable", reasons: ["the attestation API returned no bundle for the index"] };
      else {
        const v = await verifyReleaseIndex({ indexBytes: bytes2, bundle, trustedRoot, policy: { ...policy, repository: repo } });
        if (v.ok) {
          const m = indexMemory ? indexMemory.consider({ publication: v.publication, digest: v.digest, minimumRelease: v.minimumRelease, tag: v.claims?.tag ?? null }) : null;
          const base = { authenticity: "signed", indexSha256: v.digest, publication: v.publication, sequenceAuthenticated: v.sequenceAuthenticated, schema: v.schema, generatedAt: v.generatedAt, minimumRelease: `v${v.minimumRelease.join(".")}`, signedTag: v.claims?.tag ?? null };
          if (m && !m.ok) index = { status: "refused", ...base, freshness: m.kind, reasons: [m.why] };
          else {
            index = { status: "verified", ...base, freshness: m ? m.kind : "not-remembered", latest: Object.fromEntries(Object.entries(v.latest).map(([f, l]) => [f, l.tag])), revoked: v.revoked, ...m && m.persisted === false ? { memoryNotPersisted: true } : {} };
            list = candidatesFromIndex(v).map((c) => c.tag);
            latestTag = v.latest.gpu?.tag ?? list[0] ?? null;
            floor = floorOf({ caller: callerFloor, remembered, index: v.minimumRelease });
            pol = { ...pol, minimumRelease: floor.floor, revoked: revokedOf(pol.revoked, v.revoked) };
            if (keepArtifacts) indexArtifact = { bytes: bytes2.toString("base64"), sha256: v.digest, bundle };
          }
        } else index = { status: "refused", authenticity: v.signed ? "signed" : "unverified", ...v.publication ? { publication: v.publication } : {}, reasons: v.reasons.slice(-2) };
      }
    } catch (e) {
      index = { status: "unavailable", reasons: [e.message] };
    }
    if (index.status !== "verified" && requireIndex) return { ...await releaseExpectationsFrom([], { repo, trustedRoot, policy: pol }), latestTag: null, index: { ...index, ...floorRecord(floor) }, indexError: `the signed release index is required and was ${index.status}${index.freshness ? ` (${index.freshness})` : ""}: ${(index.reasons || []).join("; ")}` };
  }
  if (!list) {
    try {
      latestTag = JSON.parse((await get(`${apiBase}/repos/${repo}/releases/latest`)).toString("utf8"))?.tag_name;
      if (!TAG_RE2.test(String(latestTag))) throw new Error(`the release index named ${JSON.stringify(latestTag)}, not a vX.Y.Z tag`);
    } catch (e) {
      return { ...await releaseExpectationsFrom([], { repo, trustedRoot, policy: pol }), latestTag: null, index: { ...index, ...floorRecord(floor) }, indexError: e.message };
    }
    list = FLAVOR_SUFFIXES.map((s) => latestTag + s);
  }
  const candidates = [];
  for (const tag of list) {
    try {
      const digest = (await get(`${downloadBase}/${repo}/releases/download/${tag}/tinfoil.hash`, "text/plain")).toString("utf8").trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(digest)) {
        candidates.push({ tag, error: `tinfoil.hash is not a sha256 (${digest.slice(0, 24)}...)` });
        continue;
      }
      const att = JSON.parse((await get(`${apiBase}/repos/${repo}/attestations/sha256:${digest}`)).toString("utf8"));
      const bundle = att?.attestations?.[0]?.bundle ?? null;
      candidates.push({ tag, digest, bundle, note: bundle ? null : "the attestation API returned no inline bundle" });
    } catch (e) {
      candidates.push({ tag, error: e.message });
    }
  }
  const from = await releaseExpectationsFrom(candidates, { repo, trustedRoot, policy: pol, latestTag, keepArtifacts });
  return { ...from, index: { ...index, ...floorRecord(floor) }, ...keepArtifacts ? { artifacts: { index: indexArtifact, releases: from.artifacts?.releases ?? [] } } : {} };
}
function captureHosted({ host, port = 443, path: path5 = RAD_PATH, timeoutMs = 2e4, maxBytes = 1024 * 1024, tls = {}, now = () => /* @__PURE__ */ new Date() } = {}) {
  if (!host) return Promise.reject(new Error("captureHosted needs a host"));
  return new Promise((resolve, reject) => {
    const opts = { host, port, path: path5, method: "GET", agent: false, headers: { accept: "application/json", "user-agent": USER_AGENT, connection: "close" }, ...tls };
    if (!isIP(host)) opts.servername = host;
    const req = https.request(opts, (res) => {
      let cert = null, tlsInfo = null;
      try {
        const s = res.socket;
        cert = s.getPeerX509Certificate() ?? null;
        tlsInfo = { protocol: s.getProtocol?.() ?? null, cipher: s.getCipher?.()?.name ?? null, authorized: s.authorized === true, servername: opts.servername ?? null };
      } catch (e) {
        req.destroy(e);
        return;
      }
      const chunks = [];
      let n = 0;
      res.on("data", (c) => {
        n += c.length;
        if (n > maxBytes) {
          req.destroy(new Error(`${host}${path5}: body exceeds ${maxBytes} bytes`));
          return;
        }
        chunks.push(c);
      });
      res.on("error", reject);
      res.on("end", () => {
        try {
          if (res.statusCode !== 200) throw new Error(`${host}${path5}: HTTP ${res.statusCode}`);
          if (!cert) throw new Error(`${host}: the TLS connection presented no certificate`);
          let rad;
          try {
            rad = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            throw new Error(`${host}${path5}: the body is not JSON`);
          }
          if (!rad || typeof rad !== "object" || typeof rad.format !== "string" || typeof rad.body !== "string") throw new Error(`${host}${path5}: the document is not { format, body }`);
          const certPem = cert.toString();
          const { spki } = spkiOfCert(certPem);
          resolve({
            host,
            port,
            path: path5,
            at: now().toISOString(),
            rad,
            certPem,
            spki,
            tls: tlsInfo,
            certificate: { subject: cert.subject, issuer: cert.issuer, notBefore: cert.validFrom, notAfter: cert.validTo, sha256: cert.fingerprint256.replace(/:/g, "").toLowerCase(), sans: cert.subjectAltName || "" }
          });
        } catch (e) {
          reject(e);
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`${host}: no response within ${timeoutMs} ms`)));
    req.on("error", reject);
    req.end();
  });
}
var unsupported = (technology, why) => ({ status: "unsupported", admissionSafe: false, omissions: [], technology, reasons: [`UNSUPPORTED: ${why}`], checks: {}, claims: null });
function reportOf(rad) {
  const spec = FORMATS[rad?.format];
  if (!spec || spec.technology !== TECH.SNP || spec.supported === false) return null;
  let body = Buffer.from(String(rad.body), "base64");
  if (spec.gzip && body[0] === 31 && body[1] === 139) body = gunzipSync2(body, { maxOutputLength: 64 * 1024 });
  const p = parseReportStrict(body);
  const product = snpProductHint(p);
  return { p, product, chipHex: hex2(p.chipId), tcbHex: hex2(p.reportedTcb), kdsPath: product ? kdsVcekUrl(product, p).replace(/^https:\/\/[^/]+\//, "") : null, measurement: hex2(p.measurement), version: p.version };
}
async function verifyHostedCapture(capture, { allowed = [], minTcb = void 0, policy = {}, collateral = null, timeoutMs = 2e4, now = void 0 } = {}) {
  const at = now ? new Date(now) : /* @__PURE__ */ new Date();
  const finish = (v2) => {
    const failedChecks = Object.entries(v2.checks || {}).filter(([, x]) => x === false).map(([k]) => k);
    const measurement = v2.claims?.measurement ?? null;
    return { ...v2, at: at.toISOString(), measurement, failedChecks, matched: allowed.find((a) => a.measurement === measurement)?.tag ?? null, expected: allowed.map((a) => a.tag) };
  };
  const rad = capture?.rad;
  let env;
  try {
    env = parseEnvelope(rad);
  } catch (e) {
    if (!(e instanceof EnvelopeError)) throw e;
    return finish({ status: e.code === "unsupported" ? "unsupported" : "rejected", admissionSafe: false, omissions: [], technology: FORMATS[rad?.format]?.technology ?? null, reasons: [`${e.code.toUpperCase()}: ${e.message}`], checks: {}, claims: null });
  }
  if (env.spec.technology !== TECH.SNP)
    return finish(unsupported(env.spec.technology, `${env.format} carries ${env.spec.technology} evidence, which this consumer does not verify (it judges AMD SEV-SNP evidence only; nothing else is ever green here)`));
  if (!Buffer.isBuffer(capture.spki) || !capture.certPem) return finish({ status: "rejected", admissionSafe: false, omissions: [], technology: TECH.SNP, reasons: ["REJECT: the capture carries no served certificate; the binding cannot be judged"], checks: { binding: false }, claims: null });
  const snpPolicy = { ...policy, allowedMeasurements: allowed.map((a) => a.measurement), ...minTcb ? { minTcb } : {} };
  const v = await verifySnp(env, snpPolicy, { transportKeySpki: capture.spki, certPem: capture.certPem, host: capture.host, now: at }, collateral ?? httpCollateral({ timeoutMs }));
  const out = finish({ technology: TECH.SNP, ...v });
  if (!allowed.length) out.reasons.push("no expected measurement was available (no release's provenance verified): the measurement check cannot pass");
  return out;
}
var measurementOf = (m) => typeof m === "string" ? m.toLowerCase() : Array.isArray(m?.registers) && typeof m.registers[0] === "string" ? m.registers[0].toLowerCase() : null;
async function referenceVerify(capture, { collateral = null, timeoutMs = 2e4, load = () => import("@tinfoilsh/verifier") } = {}) {
  let mod2 = null;
  try {
    mod2 = await load();
  } catch (e) {
    return { installed: false, library: "@tinfoilsh/verifier", error: e.message };
  }
  if (!mod2 || typeof mod2.verifyAttestation !== "function") return { installed: false, library: "@tinfoilsh/verifier", error: "the module has no verifyAttestation" };
  const ref = { installed: true, library: "@tinfoilsh/verifier" };
  let rep;
  try {
    rep = reportOf(capture.rad);
  } catch (e) {
    return { ...ref, attestationOk: false, attestationError: `report: ${e.message}` };
  }
  if (!rep?.product) return { ...ref, attestationOk: false, attestationError: "not a supported SEV-SNP document (the reference is given nothing)" };
  let vcek = null;
  try {
    vcek = await (collateral ?? httpCollateral({ timeoutMs })).vcek(rep.product, rep.chipHex, rep.tcbHex, rep.kdsPath);
  } catch (e) {
    return { ...ref, attestationOk: false, attestationError: `VCEK: ${e.message}` };
  }
  if (!vcek?.der) return { ...ref, attestationOk: false, attestationError: "no VCEK from the collateral source" };
  try {
    ref.attestation = await mod2.verifyAttestation({ format: capture.rad.format, body: capture.rad.body }, Buffer.from(vcek.der).toString("base64"));
    ref.attestationOk = true;
    ref.measurement = measurementOf(ref.attestation?.measurement);
  } catch (e) {
    ref.attestationOk = false;
    ref.attestationError = e.message;
    return ref;
  }
  try {
    ref.certificate = await mod2.verifyCertificate(capture.certPem, capture.host, { format: capture.rad.format, body: capture.rad.body }, ref.attestation.hpkePublicKey);
    ref.certificateOk = true;
  } catch (e) {
    ref.certificateOk = false;
    ref.certificateError = e.message;
  }
  return ref;
}
function compareVerdicts({ ours, reference, allowed = [] }) {
  const inProvenance = (m) => !!m && allowed.some((a) => a.measurement === m);
  if (!reference || reference.skipped || reference.installed === false) return { agreement: "reference-missing", reasons: [reference?.error ? `reference: ${reference.error}` : "no reference verifier ran"] };
  const theirsBytes = reference.attestationOk === true && reference.certificateOk === true;
  const theirsAccepts = theirsBytes && inProvenance(reference.measurement);
  const failed = Object.entries(ours?.checks || {}).filter(([, v]) => v === false).map(([k]) => k);
  const limitedClean = ours?.status === "limited" && failed.length === 0;
  const oursBytes = ours?.status === "verified" || limitedClean || ours?.status === "rejected" && failed.length === 1 && failed[0] === "measurement";
  const oursMeasurement = ours?.claims?.measurement ?? null;
  const detail = {
    bytesAgree: oursBytes === theirsBytes,
    oursBytesOk: oursBytes,
    referenceBytesOk: theirsBytes,
    sameMeasurement: !!reference.measurement && reference.measurement === oursMeasurement,
    measurementInProvenance: inProvenance(oursMeasurement),
    oursFailedChecks: failed
  };
  if (ours?.status === "verified" && theirsAccepts && detail.sameMeasurement) return { agreement: "agree", ...detail, reasons: [`both verified ${oursMeasurement.slice(0, 16)}..., a verified release's measurement`] };
  if (limitedClean && theirsAccepts && detail.sameMeasurement)
    return { agreement: "agree-limited", ...detail, omissions: ours.omissions ?? [], reasons: [`both accept the bytes and the measurement ${oursMeasurement.slice(0, 16)}...; ours withholds "verified" for ${(ours.omissions || []).join(", ") || "an omission"} (the reference applies its own built-in floor; ours judges only a floor the caller states)`] };
  if (ours?.status !== "verified" && !theirsAccepts && detail.bytesAgree && (!oursBytes || detail.sameMeasurement))
    return { agreement: "agree-refuse", ...detail, reasons: [oursBytes ? `both accept the bytes; the measurement ${oursMeasurement ? oursMeasurement.slice(0, 16) : "-"}... is not one a verified release vouches for` : `both refuse the bytes (ours: ${failed.join(",") || ours?.status}; reference: ${reference.attestationError || reference.certificateError || "refused"})`] };
  return { agreement: "disagree", ...detail, reasons: [`ours ${ours?.status} (${oursMeasurement ? oursMeasurement.slice(0, 16) : "-"}; failed ${failed.join(",") || "none"}), reference bytes ${theirsBytes ? "ok" : "refused"} (${reference.measurement ? reference.measurement.slice(0, 16) : "-"}${reference.attestationError ? `; ${reference.attestationError}` : ""}${reference.certificateError ? `; ${reference.certificateError}` : ""})`] };
}
function dualAgreement({ reference, own }) {
  if (!reference || !own || reference.available === false || own.status === "unavailable") return "not-compared";
  const same = !!reference.measurement && String(reference.measurement).toLowerCase() === String(own.measurement || "").toLowerCase();
  if (reference.pass === true && own.status === "verified" && same) return "agree";
  if (reference.pass === true && own.status === "limited" && same) return "agree-limited";
  if (reference.pass !== true && own.status !== "verified" && own.status !== "limited") return "agree-refuse";
  return "differ";
}
async function verifyHost({
  host,
  port = 443,
  path: path5 = RAD_PATH,
  timeoutMs = 2e4,
  tls = {},
  collateral = null,
  expectations = null,
  repo = DEFAULT_REPO,
  reference = true,
  referenceLoad = void 0,
  minTcb = void 0,
  policy = {},
  now = void 0,
  fetchImpl = globalThis.fetch,
  indexMemory = null,
  requireIndex = false
} = {}) {
  const at = (now ? new Date(now) : /* @__PURE__ */ new Date()).toISOString();
  const exp = expectations ?? await releaseExpectations({ repo, fetchImpl, timeoutMs, indexMemory, requireIndex });
  const out = {
    verifier: "enclave",
    host,
    at,
    expectations: { repo: exp.repo, latestTag: exp.latestTag ?? null, ok: exp.ok, allowed: exp.allowed.map((a) => ({ tag: a.tag, measurement: a.measurement })), candidates: exp.candidates, index: exp.index ?? null, ...exp.indexError ? { indexError: exp.indexError } : {} },
    capture: null,
    enclave: null,
    reference: null,
    comparison: null
  };
  let cap;
  try {
    cap = await captureHosted({ host, port, path: path5, timeoutMs, tls, now: () => new Date(at) });
  } catch (e) {
    out.enclave = { status: "unavailable", admissionSafe: false, reasons: [`capture: ${e.message}`], checks: {}, claims: null, failedChecks: [], matched: null, expected: exp.allowed.map((a) => a.tag) };
    out.comparison = { agreement: "reference-missing", reasons: ["no capture"] };
    return out;
  }
  let rep = null;
  try {
    rep = reportOf(cap.rad);
  } catch {
    rep = null;
  }
  out.capture = { at: cap.at, format: cap.rad.format, product: rep?.product ?? null, reportVersion: rep?.version ?? null, measurement: rep?.measurement ?? null, tls: cap.tls, certificate: cap.certificate };
  out.enclave = await verifyHostedCapture(cap, { allowed: exp.allowed, minTcb, policy, collateral, timeoutMs, now: at });
  out.reference = reference ? await referenceVerify(cap, { collateral, timeoutMs, ...referenceLoad ? { load: referenceLoad } : {} }) : { skipped: true };
  out.comparison = compareVerdicts({ ours: out.enclave, reference: out.reference, allowed: exp.allowed });
  return out;
}
async function selfCheckHosted({
  publicHost,
  loopback = { host: "127.0.0.1", port: 443 },
  repo = DEFAULT_REPO,
  releaseIndex = null,
  expectations = null,
  collateral = null,
  minTcb = void 0,
  timeoutMs = 15e3,
  fetchImpl = globalThis.fetch,
  now = void 0,
  indexMemory = null,
  requireIndex = false
} = {}) {
  const at = (now ? new Date(now) : /* @__PURE__ */ new Date()).toISOString();
  const brief = (v2, extra = {}) => ({
    verifier: "enclave",
    status: v2.status,
    at,
    release: v2.matched ?? null,
    expected: v2.expected ?? [],
    measurement: v2.measurement ?? null,
    failedChecks: v2.failedChecks ?? [],
    omissions: v2.omissions ?? [],
    checks: v2.checks ?? {},
    reasons: (v2.reasons ?? []).slice(-4),
    ...extra
  });
  if (!publicHost) return brief({ status: "unavailable", reasons: ["public origin not known yet"] });
  let exp = expectations;
  if (!exp) {
    try {
      exp = await releaseExpectations({ repo, fetchImpl, timeoutMs, indexMemory, requireIndex, ...releaseIndex ? { apiBase: releaseIndex.apiBase, downloadBase: releaseIndex.downloadBase ?? releaseIndex.apiBase } : {} });
    } catch (e) {
      return brief({ status: "unavailable", reasons: [`release provenance: ${e.message}`] });
    }
  }
  let cap;
  try {
    cap = await captureHosted({ host: loopback.host, port: loopback.port, timeoutMs, tls: { rejectUnauthorized: false, servername: publicHost } });
    cap = { ...cap, host: publicHost };
  } catch (e) {
    return brief({ status: "unavailable", reasons: [`capture over loopback: ${e.message}`] }, { expected: exp.allowed.map((a) => a.tag), latestTag: exp.latestTag ?? null, indexError: exp.indexError ?? null });
  }
  let v;
  try {
    v = await verifyHostedCapture(cap, { allowed: exp.allowed, minTcb, collateral, timeoutMs, now: at });
  } catch (e) {
    return brief({ status: "unavailable", reasons: [`verifier: ${e.message}`] }, { expected: exp.allowed.map((a) => a.tag) });
  }
  return brief(v, { latestTag: exp.latestTag ?? null, index: exp.index ?? null, ...exp.indexError ? { indexError: exp.indexError } : {}, certificate: { subject: cap.certificate.subject, sha256: cap.certificate.sha256, notAfter: cap.certificate.notAfter } });
}
var sha256Hex = sha256hex2;
export {
  DEFAULT_REPO,
  FLAVOR_SUFFIXES,
  GITHUB_API,
  GITHUB_DOWNLOADS,
  RAD_PATH,
  RELEASE_POLICY,
  TRUSTED_ROOT,
  USER_AGENT,
  cachedCollateral,
  captureHosted,
  compareVerdicts,
  createFileIndexMemory as createIndexMemory,
  dualAgreement,
  fetchBounded,
  fileCollateral,
  httpCollateral,
  layeredCollateral,
  memoryCollateral,
  memoryStore,
  prewarmSnpCollateral,
  referenceVerify,
  releaseExpectations,
  releaseExpectationsFrom,
  reportOf,
  selfCheckHosted,
  sha256Hex,
  verifyGuestDomainEvidence,
  verifyHost,
  verifyHostedCapture,
  webStorageStore
};
