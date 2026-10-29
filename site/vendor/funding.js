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

// ../../enclave/node_modules/abitype/dist/esm/version.js
var version;
var init_version = __esm({
  "../../enclave/node_modules/abitype/dist/esm/version.js"() {
    version = "1.2.3";
  }
});

// ../../enclave/node_modules/abitype/dist/esm/errors.js
var BaseError;
var init_errors = __esm({
  "../../enclave/node_modules/abitype/dist/esm/errors.js"() {
    init_version();
    BaseError = class _BaseError extends Error {
      constructor(shortMessage, args = {}) {
        const details = args.cause instanceof _BaseError ? args.cause.details : args.cause?.message ? args.cause.message : args.details;
        const docsPath5 = args.cause instanceof _BaseError ? args.cause.docsPath || args.docsPath : args.docsPath;
        const message = [
          shortMessage || "An error occurred.",
          "",
          ...args.metaMessages ? [...args.metaMessages, ""] : [],
          ...docsPath5 ? [`Docs: https://abitype.dev${docsPath5}`] : [],
          ...details ? [`Details: ${details}`] : [],
          `Version: abitype@${version}`
        ].join("\n");
        super(message);
        Object.defineProperty(this, "details", {
          enumerable: true,
          configurable: true,
          writable: true,
          value: void 0
        });
        Object.defineProperty(this, "docsPath", {
          enumerable: true,
          configurable: true,
          writable: true,
          value: void 0
        });
        Object.defineProperty(this, "metaMessages", {
          enumerable: true,
          configurable: true,
          writable: true,
          value: void 0
        });
        Object.defineProperty(this, "shortMessage", {
          enumerable: true,
          configurable: true,
          writable: true,
          value: void 0
        });
        Object.defineProperty(this, "name", {
          enumerable: true,
          configurable: true,
          writable: true,
          value: "AbiTypeError"
        });
        if (args.cause)
          this.cause = args.cause;
        this.details = details;
        this.docsPath = docsPath5;
        this.metaMessages = args.metaMessages;
        this.shortMessage = shortMessage;
      }
    };
  }
});

// ../../enclave/node_modules/abitype/dist/esm/regex.js
function execTyped(regex, string) {
  const match = regex.exec(string);
  return match?.groups;
}
var bytesRegex, integerRegex, isTupleRegex;
var init_regex = __esm({
  "../../enclave/node_modules/abitype/dist/esm/regex.js"() {
    bytesRegex = /^bytes([1-9]|1[0-9]|2[0-9]|3[0-2])?$/;
    integerRegex = /^u?int(8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)?$/;
    isTupleRegex = /^\(.+?\).*?$/;
  }
});

// ../../enclave/node_modules/abitype/dist/esm/human-readable/formatAbiParameter.js
function formatAbiParameter(abiParameter) {
  let type = abiParameter.type;
  if (tupleRegex.test(abiParameter.type) && "components" in abiParameter) {
    type = "(";
    const length = abiParameter.components.length;
    for (let i = 0; i < length; i++) {
      const component = abiParameter.components[i];
      type += formatAbiParameter(component);
      if (i < length - 1)
        type += ", ";
    }
    const result = execTyped(tupleRegex, abiParameter.type);
    type += `)${result?.array || ""}`;
    return formatAbiParameter({
      ...abiParameter,
      type
    });
  }
  if ("indexed" in abiParameter && abiParameter.indexed)
    type = `${type} indexed`;
  if (abiParameter.name)
    return `${type} ${abiParameter.name}`;
  return type;
}
var tupleRegex;
var init_formatAbiParameter = __esm({
  "../../enclave/node_modules/abitype/dist/esm/human-readable/formatAbiParameter.js"() {
    init_regex();
    tupleRegex = /^tuple(?<array>(\[(\d*)\])*)$/;
  }
});

// ../../enclave/node_modules/abitype/dist/esm/human-readable/formatAbiParameters.js
function formatAbiParameters(abiParameters) {
  let params = "";
  const length = abiParameters.length;
  for (let i = 0; i < length; i++) {
    const abiParameter = abiParameters[i];
    params += formatAbiParameter(abiParameter);
    if (i !== length - 1)
      params += ", ";
  }
  return params;
}
var init_formatAbiParameters = __esm({
  "../../enclave/node_modules/abitype/dist/esm/human-readable/formatAbiParameters.js"() {
    init_formatAbiParameter();
  }
});

// ../../enclave/node_modules/abitype/dist/esm/human-readable/formatAbiItem.js
function formatAbiItem(abiItem) {
  if (abiItem.type === "function")
    return `function ${abiItem.name}(${formatAbiParameters(abiItem.inputs)})${abiItem.stateMutability && abiItem.stateMutability !== "nonpayable" ? ` ${abiItem.stateMutability}` : ""}${abiItem.outputs?.length ? ` returns (${formatAbiParameters(abiItem.outputs)})` : ""}`;
  if (abiItem.type === "event")
    return `event ${abiItem.name}(${formatAbiParameters(abiItem.inputs)})`;
  if (abiItem.type === "error")
    return `error ${abiItem.name}(${formatAbiParameters(abiItem.inputs)})`;
  if (abiItem.type === "constructor")
    return `constructor(${formatAbiParameters(abiItem.inputs)})${abiItem.stateMutability === "payable" ? " payable" : ""}`;
  if (abiItem.type === "fallback")
    return `fallback() external${abiItem.stateMutability === "payable" ? " payable" : ""}`;
  return "receive() external payable";
}
var init_formatAbiItem = __esm({
  "../../enclave/node_modules/abitype/dist/esm/human-readable/formatAbiItem.js"() {
    init_formatAbiParameters();
  }
});

// ../../enclave/node_modules/abitype/dist/esm/human-readable/runtime/signatures.js
function isErrorSignature(signature) {
  return errorSignatureRegex.test(signature);
}
function execErrorSignature(signature) {
  return execTyped(errorSignatureRegex, signature);
}
function isEventSignature(signature) {
  return eventSignatureRegex.test(signature);
}
function execEventSignature(signature) {
  return execTyped(eventSignatureRegex, signature);
}
function isFunctionSignature(signature) {
  return functionSignatureRegex.test(signature);
}
function execFunctionSignature(signature) {
  return execTyped(functionSignatureRegex, signature);
}
function isStructSignature(signature) {
  return structSignatureRegex.test(signature);
}
function execStructSignature(signature) {
  return execTyped(structSignatureRegex, signature);
}
function isConstructorSignature(signature) {
  return constructorSignatureRegex.test(signature);
}
function execConstructorSignature(signature) {
  return execTyped(constructorSignatureRegex, signature);
}
function isFallbackSignature(signature) {
  return fallbackSignatureRegex.test(signature);
}
function execFallbackSignature(signature) {
  return execTyped(fallbackSignatureRegex, signature);
}
function isReceiveSignature(signature) {
  return receiveSignatureRegex.test(signature);
}
var errorSignatureRegex, eventSignatureRegex, functionSignatureRegex, structSignatureRegex, constructorSignatureRegex, fallbackSignatureRegex, receiveSignatureRegex, eventModifiers, functionModifiers;
var init_signatures = __esm({
  "../../enclave/node_modules/abitype/dist/esm/human-readable/runtime/signatures.js"() {
    init_regex();
    errorSignatureRegex = /^error (?<name>[a-zA-Z$_][a-zA-Z0-9$_]*)\((?<parameters>.*?)\)$/;
    eventSignatureRegex = /^event (?<name>[a-zA-Z$_][a-zA-Z0-9$_]*)\((?<parameters>.*?)\)$/;
    functionSignatureRegex = /^function (?<name>[a-zA-Z$_][a-zA-Z0-9$_]*)\((?<parameters>.*?)\)(?: (?<scope>external|public{1}))?(?: (?<stateMutability>pure|view|nonpayable|payable{1}))?(?: returns\s?\((?<returns>.*?)\))?$/;
    structSignatureRegex = /^struct (?<name>[a-zA-Z$_][a-zA-Z0-9$_]*) \{(?<properties>.*?)\}$/;
    constructorSignatureRegex = /^constructor\((?<parameters>.*?)\)(?:\s(?<stateMutability>payable{1}))?$/;
    fallbackSignatureRegex = /^fallback\(\) external(?:\s(?<stateMutability>payable{1}))?$/;
    receiveSignatureRegex = /^receive\(\) external payable$/;
    eventModifiers = /* @__PURE__ */ new Set(["indexed"]);
    functionModifiers = /* @__PURE__ */ new Set([
      "calldata",
      "memory",
      "storage"
    ]);
  }
});

// ../../enclave/node_modules/abitype/dist/esm/human-readable/errors/abiItem.js
var UnknownTypeError, UnknownSolidityTypeError;
var init_abiItem = __esm({
  "../../enclave/node_modules/abitype/dist/esm/human-readable/errors/abiItem.js"() {
    init_errors();
    UnknownTypeError = class extends BaseError {
      constructor({ type }) {
        super("Unknown type.", {
          metaMessages: [
            `Type "${type}" is not a valid ABI type. Perhaps you forgot to include a struct signature?`
          ]
        });
        Object.defineProperty(this, "name", {
          enumerable: true,
          configurable: true,
          writable: true,
          value: "UnknownTypeError"
        });
      }
    };
    UnknownSolidityTypeError = class extends BaseError {
      constructor({ type }) {
        super("Unknown type.", {
          metaMessages: [`Type "${type}" is not a valid ABI type.`]
        });
        Object.defineProperty(this, "name", {
          enumerable: true,
          configurable: true,
          writable: true,
          value: "UnknownSolidityTypeError"
        });
      }
    };
  }
});

// ../../enclave/node_modules/abitype/dist/esm/human-readable/errors/abiParameter.js
var InvalidParameterError, SolidityProtectedKeywordError, InvalidModifierError, InvalidFunctionModifierError, InvalidAbiTypeParameterError;
var init_abiParameter = __esm({
  "../../enclave/node_modules/abitype/dist/esm/human-readable/errors/abiParameter.js"() {
    init_errors();
    InvalidParameterError = class extends BaseError {
      constructor({ param }) {
        super("Invalid ABI parameter.", {
          details: param
        });
        Object.defineProperty(this, "name", {
          enumerable: true,
          configurable: true,
          writable: true,
          value: "InvalidParameterError"
        });
      }
    };
    SolidityProtectedKeywordError = class extends BaseError {
      constructor({ param, name }) {
        super("Invalid ABI parameter.", {
          details: param,
          metaMessages: [
            `"${name}" is a protected Solidity keyword. More info: https://docs.soliditylang.org/en/latest/cheatsheet.html`
          ]
        });
        Object.defineProperty(this, "name", {
          enumerable: true,
          configurable: true,
          writable: true,
          value: "SolidityProtectedKeywordError"
        });
      }
    };
    InvalidModifierError = class extends BaseError {
      constructor({ param, type, modifier }) {
        super("Invalid ABI parameter.", {
          details: param,
          metaMessages: [
            `Modifier "${modifier}" not allowed${type ? ` in "${type}" type` : ""}.`
          ]
        });
        Object.defineProperty(this, "name", {
          enumerable: true,
          configurable: true,
          writable: true,
          value: "InvalidModifierError"
        });
      }
    };
    InvalidFunctionModifierError = class extends BaseError {
      constructor({ param, type, modifier }) {
        super("Invalid ABI parameter.", {
          details: param,
          metaMessages: [
            `Modifier "${modifier}" not allowed${type ? ` in "${type}" type` : ""}.`,
            `Data location can only be specified for array, struct, or mapping types, but "${modifier}" was given.`
          ]
        });
        Object.defineProperty(this, "name", {
          enumerable: true,
          configurable: true,
          writable: true,
          value: "InvalidFunctionModifierError"
        });
      }
    };
    InvalidAbiTypeParameterError = class extends BaseError {
      constructor({ abiParameter }) {
        super("Invalid ABI parameter.", {
          details: JSON.stringify(abiParameter, null, 2),
          metaMessages: ["ABI parameter type is invalid."]
        });
        Object.defineProperty(this, "name", {
          enumerable: true,
          configurable: true,
          writable: true,
          value: "InvalidAbiTypeParameterError"
        });
      }
    };
  }
});

// ../../enclave/node_modules/abitype/dist/esm/human-readable/errors/signature.js
var InvalidSignatureError, UnknownSignatureError, InvalidStructSignatureError;
var init_signature = __esm({
  "../../enclave/node_modules/abitype/dist/esm/human-readable/errors/signature.js"() {
    init_errors();
    InvalidSignatureError = class extends BaseError {
      constructor({ signature, type }) {
        super(`Invalid ${type} signature.`, {
          details: signature
        });
        Object.defineProperty(this, "name", {
          enumerable: true,
          configurable: true,
          writable: true,
          value: "InvalidSignatureError"
        });
      }
    };
    UnknownSignatureError = class extends BaseError {
      constructor({ signature }) {
        super("Unknown signature.", {
          details: signature
        });
        Object.defineProperty(this, "name", {
          enumerable: true,
          configurable: true,
          writable: true,
          value: "UnknownSignatureError"
        });
      }
    };
    InvalidStructSignatureError = class extends BaseError {
      constructor({ signature }) {
        super("Invalid struct signature.", {
          details: signature,
          metaMessages: ["No properties exist."]
        });
        Object.defineProperty(this, "name", {
          enumerable: true,
          configurable: true,
          writable: true,
          value: "InvalidStructSignatureError"
        });
      }
    };
  }
});

// ../../enclave/node_modules/abitype/dist/esm/human-readable/errors/struct.js
var CircularReferenceError;
var init_struct = __esm({
  "../../enclave/node_modules/abitype/dist/esm/human-readable/errors/struct.js"() {
    init_errors();
    CircularReferenceError = class extends BaseError {
      constructor({ type }) {
        super("Circular reference detected.", {
          metaMessages: [`Struct "${type}" is a circular reference.`]
        });
        Object.defineProperty(this, "name", {
          enumerable: true,
          configurable: true,
          writable: true,
          value: "CircularReferenceError"
        });
      }
    };
  }
});

// ../../enclave/node_modules/abitype/dist/esm/human-readable/errors/splitParameters.js
var InvalidParenthesisError;
var init_splitParameters = __esm({
  "../../enclave/node_modules/abitype/dist/esm/human-readable/errors/splitParameters.js"() {
    init_errors();
    InvalidParenthesisError = class extends BaseError {
      constructor({ current, depth }) {
        super("Unbalanced parentheses.", {
          metaMessages: [
            `"${current.trim()}" has too many ${depth > 0 ? "opening" : "closing"} parentheses.`
          ],
          details: `Depth "${depth}"`
        });
        Object.defineProperty(this, "name", {
          enumerable: true,
          configurable: true,
          writable: true,
          value: "InvalidParenthesisError"
        });
      }
    };
  }
});

// ../../enclave/node_modules/abitype/dist/esm/human-readable/runtime/cache.js
function getParameterCacheKey(param, type, structs) {
  let structKey = "";
  if (structs)
    for (const struct of Object.entries(structs)) {
      if (!struct)
        continue;
      let propertyKey = "";
      for (const property of struct[1]) {
        propertyKey += `[${property.type}${property.name ? `:${property.name}` : ""}]`;
      }
      structKey += `(${struct[0]}{${propertyKey}})`;
    }
  if (type)
    return `${type}:${param}${structKey}`;
  return `${param}${structKey}`;
}
var parameterCache;
var init_cache = __esm({
  "../../enclave/node_modules/abitype/dist/esm/human-readable/runtime/cache.js"() {
    parameterCache = /* @__PURE__ */ new Map([
      // Unnamed
      ["address", { type: "address" }],
      ["bool", { type: "bool" }],
      ["bytes", { type: "bytes" }],
      ["bytes32", { type: "bytes32" }],
      ["int", { type: "int256" }],
      ["int256", { type: "int256" }],
      ["string", { type: "string" }],
      ["uint", { type: "uint256" }],
      ["uint8", { type: "uint8" }],
      ["uint16", { type: "uint16" }],
      ["uint24", { type: "uint24" }],
      ["uint32", { type: "uint32" }],
      ["uint64", { type: "uint64" }],
      ["uint96", { type: "uint96" }],
      ["uint112", { type: "uint112" }],
      ["uint160", { type: "uint160" }],
      ["uint192", { type: "uint192" }],
      ["uint256", { type: "uint256" }],
      // Named
      ["address owner", { type: "address", name: "owner" }],
      ["address to", { type: "address", name: "to" }],
      ["bool approved", { type: "bool", name: "approved" }],
      ["bytes _data", { type: "bytes", name: "_data" }],
      ["bytes data", { type: "bytes", name: "data" }],
      ["bytes signature", { type: "bytes", name: "signature" }],
      ["bytes32 hash", { type: "bytes32", name: "hash" }],
      ["bytes32 r", { type: "bytes32", name: "r" }],
      ["bytes32 root", { type: "bytes32", name: "root" }],
      ["bytes32 s", { type: "bytes32", name: "s" }],
      ["string name", { type: "string", name: "name" }],
      ["string symbol", { type: "string", name: "symbol" }],
      ["string tokenURI", { type: "string", name: "tokenURI" }],
      ["uint tokenId", { type: "uint256", name: "tokenId" }],
      ["uint8 v", { type: "uint8", name: "v" }],
      ["uint256 balance", { type: "uint256", name: "balance" }],
      ["uint256 tokenId", { type: "uint256", name: "tokenId" }],
      ["uint256 value", { type: "uint256", name: "value" }],
      // Indexed
      [
        "event:address indexed from",
        { type: "address", name: "from", indexed: true }
      ],
      ["event:address indexed to", { type: "address", name: "to", indexed: true }],
      [
        "event:uint indexed tokenId",
        { type: "uint256", name: "tokenId", indexed: true }
      ],
      [
        "event:uint256 indexed tokenId",
        { type: "uint256", name: "tokenId", indexed: true }
      ]
    ]);
  }
});

// ../../enclave/node_modules/abitype/dist/esm/human-readable/runtime/utils.js
function parseSignature(signature, structs = {}) {
  if (isFunctionSignature(signature))
    return parseFunctionSignature(signature, structs);
  if (isEventSignature(signature))
    return parseEventSignature(signature, structs);
  if (isErrorSignature(signature))
    return parseErrorSignature(signature, structs);
  if (isConstructorSignature(signature))
    return parseConstructorSignature(signature, structs);
  if (isFallbackSignature(signature))
    return parseFallbackSignature(signature);
  if (isReceiveSignature(signature))
    return {
      type: "receive",
      stateMutability: "payable"
    };
  throw new UnknownSignatureError({ signature });
}
function parseFunctionSignature(signature, structs = {}) {
  const match = execFunctionSignature(signature);
  if (!match)
    throw new InvalidSignatureError({ signature, type: "function" });
  const inputParams = splitParameters(match.parameters);
  const inputs = [];
  const inputLength = inputParams.length;
  for (let i = 0; i < inputLength; i++) {
    inputs.push(parseAbiParameter(inputParams[i], {
      modifiers: functionModifiers,
      structs,
      type: "function"
    }));
  }
  const outputs = [];
  if (match.returns) {
    const outputParams = splitParameters(match.returns);
    const outputLength = outputParams.length;
    for (let i = 0; i < outputLength; i++) {
      outputs.push(parseAbiParameter(outputParams[i], {
        modifiers: functionModifiers,
        structs,
        type: "function"
      }));
    }
  }
  return {
    name: match.name,
    type: "function",
    stateMutability: match.stateMutability ?? "nonpayable",
    inputs,
    outputs
  };
}
function parseEventSignature(signature, structs = {}) {
  const match = execEventSignature(signature);
  if (!match)
    throw new InvalidSignatureError({ signature, type: "event" });
  const params = splitParameters(match.parameters);
  const abiParameters = [];
  const length = params.length;
  for (let i = 0; i < length; i++)
    abiParameters.push(parseAbiParameter(params[i], {
      modifiers: eventModifiers,
      structs,
      type: "event"
    }));
  return { name: match.name, type: "event", inputs: abiParameters };
}
function parseErrorSignature(signature, structs = {}) {
  const match = execErrorSignature(signature);
  if (!match)
    throw new InvalidSignatureError({ signature, type: "error" });
  const params = splitParameters(match.parameters);
  const abiParameters = [];
  const length = params.length;
  for (let i = 0; i < length; i++)
    abiParameters.push(parseAbiParameter(params[i], { structs, type: "error" }));
  return { name: match.name, type: "error", inputs: abiParameters };
}
function parseConstructorSignature(signature, structs = {}) {
  const match = execConstructorSignature(signature);
  if (!match)
    throw new InvalidSignatureError({ signature, type: "constructor" });
  const params = splitParameters(match.parameters);
  const abiParameters = [];
  const length = params.length;
  for (let i = 0; i < length; i++)
    abiParameters.push(parseAbiParameter(params[i], { structs, type: "constructor" }));
  return {
    type: "constructor",
    stateMutability: match.stateMutability ?? "nonpayable",
    inputs: abiParameters
  };
}
function parseFallbackSignature(signature) {
  const match = execFallbackSignature(signature);
  if (!match)
    throw new InvalidSignatureError({ signature, type: "fallback" });
  return {
    type: "fallback",
    stateMutability: match.stateMutability ?? "nonpayable"
  };
}
function parseAbiParameter(param, options) {
  const parameterCacheKey = getParameterCacheKey(param, options?.type, options?.structs);
  if (parameterCache.has(parameterCacheKey))
    return parameterCache.get(parameterCacheKey);
  const isTuple = isTupleRegex.test(param);
  const match = execTyped(isTuple ? abiParameterWithTupleRegex : abiParameterWithoutTupleRegex, param);
  if (!match)
    throw new InvalidParameterError({ param });
  if (match.name && isSolidityKeyword(match.name))
    throw new SolidityProtectedKeywordError({ param, name: match.name });
  const name = match.name ? { name: match.name } : {};
  const indexed = match.modifier === "indexed" ? { indexed: true } : {};
  const structs = options?.structs ?? {};
  let type;
  let components = {};
  if (isTuple) {
    type = "tuple";
    const params = splitParameters(match.type);
    const components_ = [];
    const length = params.length;
    for (let i = 0; i < length; i++) {
      components_.push(parseAbiParameter(params[i], { structs }));
    }
    components = { components: components_ };
  } else if (match.type in structs) {
    type = "tuple";
    components = { components: structs[match.type] };
  } else if (dynamicIntegerRegex.test(match.type)) {
    type = `${match.type}256`;
  } else if (match.type === "address payable") {
    type = "address";
  } else {
    type = match.type;
    if (!(options?.type === "struct") && !isSolidityType(type))
      throw new UnknownSolidityTypeError({ type });
  }
  if (match.modifier) {
    if (!options?.modifiers?.has?.(match.modifier))
      throw new InvalidModifierError({
        param,
        type: options?.type,
        modifier: match.modifier
      });
    if (functionModifiers.has(match.modifier) && !isValidDataLocation(type, !!match.array))
      throw new InvalidFunctionModifierError({
        param,
        type: options?.type,
        modifier: match.modifier
      });
  }
  const abiParameter = {
    type: `${type}${match.array ?? ""}`,
    ...name,
    ...indexed,
    ...components
  };
  parameterCache.set(parameterCacheKey, abiParameter);
  return abiParameter;
}
function splitParameters(params, result = [], current = "", depth = 0) {
  const length = params.trim().length;
  for (let i = 0; i < length; i++) {
    const char = params[i];
    const tail = params.slice(i + 1);
    switch (char) {
      case ",":
        return depth === 0 ? splitParameters(tail, [...result, current.trim()]) : splitParameters(tail, result, `${current}${char}`, depth);
      case "(":
        return splitParameters(tail, result, `${current}${char}`, depth + 1);
      case ")":
        return splitParameters(tail, result, `${current}${char}`, depth - 1);
      default:
        return splitParameters(tail, result, `${current}${char}`, depth);
    }
  }
  if (current === "")
    return result;
  if (depth !== 0)
    throw new InvalidParenthesisError({ current, depth });
  result.push(current.trim());
  return result;
}
function isSolidityType(type) {
  return type === "address" || type === "bool" || type === "function" || type === "string" || bytesRegex.test(type) || integerRegex.test(type);
}
function isSolidityKeyword(name) {
  return name === "address" || name === "bool" || name === "function" || name === "string" || name === "tuple" || bytesRegex.test(name) || integerRegex.test(name) || protectedKeywordsRegex.test(name);
}
function isValidDataLocation(type, isArray) {
  return isArray || type === "bytes" || type === "string" || type === "tuple";
}
var abiParameterWithoutTupleRegex, abiParameterWithTupleRegex, dynamicIntegerRegex, protectedKeywordsRegex;
var init_utils = __esm({
  "../../enclave/node_modules/abitype/dist/esm/human-readable/runtime/utils.js"() {
    init_regex();
    init_abiItem();
    init_abiParameter();
    init_signature();
    init_splitParameters();
    init_cache();
    init_signatures();
    abiParameterWithoutTupleRegex = /^(?<type>[a-zA-Z$_][a-zA-Z0-9$_]*(?:\spayable)?)(?<array>(?:\[\d*?\])+?)?(?:\s(?<modifier>calldata|indexed|memory|storage{1}))?(?:\s(?<name>[a-zA-Z$_][a-zA-Z0-9$_]*))?$/;
    abiParameterWithTupleRegex = /^\((?<type>.+?)\)(?<array>(?:\[\d*?\])+?)?(?:\s(?<modifier>calldata|indexed|memory|storage{1}))?(?:\s(?<name>[a-zA-Z$_][a-zA-Z0-9$_]*))?$/;
    dynamicIntegerRegex = /^u?int$/;
    protectedKeywordsRegex = /^(?:after|alias|anonymous|apply|auto|byte|calldata|case|catch|constant|copyof|default|defined|error|event|external|false|final|function|immutable|implements|in|indexed|inline|internal|let|mapping|match|memory|mutable|null|of|override|partial|private|promise|public|pure|reference|relocatable|return|returns|sizeof|static|storage|struct|super|supports|switch|this|true|try|typedef|typeof|var|view|virtual)$/;
  }
});

// ../../enclave/node_modules/abitype/dist/esm/human-readable/runtime/structs.js
function parseStructs(signatures) {
  const shallowStructs = {};
  const signaturesLength = signatures.length;
  for (let i = 0; i < signaturesLength; i++) {
    const signature = signatures[i];
    if (!isStructSignature(signature))
      continue;
    const match = execStructSignature(signature);
    if (!match)
      throw new InvalidSignatureError({ signature, type: "struct" });
    const properties = match.properties.split(";");
    const components = [];
    const propertiesLength = properties.length;
    for (let k = 0; k < propertiesLength; k++) {
      const property = properties[k];
      const trimmed = property.trim();
      if (!trimmed)
        continue;
      const abiParameter = parseAbiParameter(trimmed, {
        type: "struct"
      });
      components.push(abiParameter);
    }
    if (!components.length)
      throw new InvalidStructSignatureError({ signature });
    shallowStructs[match.name] = components;
  }
  const resolvedStructs = {};
  const entries = Object.entries(shallowStructs);
  const entriesLength = entries.length;
  for (let i = 0; i < entriesLength; i++) {
    const [name, parameters] = entries[i];
    resolvedStructs[name] = resolveStructs(parameters, shallowStructs);
  }
  return resolvedStructs;
}
function resolveStructs(abiParameters = [], structs = {}, ancestors = /* @__PURE__ */ new Set()) {
  const components = [];
  const length = abiParameters.length;
  for (let i = 0; i < length; i++) {
    const abiParameter = abiParameters[i];
    const isTuple = isTupleRegex.test(abiParameter.type);
    if (isTuple)
      components.push(abiParameter);
    else {
      const match = execTyped(typeWithoutTupleRegex, abiParameter.type);
      if (!match?.type)
        throw new InvalidAbiTypeParameterError({ abiParameter });
      const { array, type } = match;
      if (type in structs) {
        if (ancestors.has(type))
          throw new CircularReferenceError({ type });
        components.push({
          ...abiParameter,
          type: `tuple${array ?? ""}`,
          components: resolveStructs(structs[type], structs, /* @__PURE__ */ new Set([...ancestors, type]))
        });
      } else {
        if (isSolidityType(type))
          components.push(abiParameter);
        else
          throw new UnknownTypeError({ type });
      }
    }
  }
  return components;
}
var typeWithoutTupleRegex;
var init_structs = __esm({
  "../../enclave/node_modules/abitype/dist/esm/human-readable/runtime/structs.js"() {
    init_regex();
    init_abiItem();
    init_abiParameter();
    init_signature();
    init_struct();
    init_signatures();
    init_utils();
    typeWithoutTupleRegex = /^(?<type>[a-zA-Z$_][a-zA-Z0-9$_]*)(?<array>(?:\[\d*?\])+?)?$/;
  }
});

// ../../enclave/node_modules/abitype/dist/esm/human-readable/parseAbi.js
function parseAbi(signatures) {
  const structs = parseStructs(signatures);
  const abi = [];
  const length = signatures.length;
  for (let i = 0; i < length; i++) {
    const signature = signatures[i];
    if (isStructSignature(signature))
      continue;
    abi.push(parseSignature(signature, structs));
  }
  return abi;
}
var init_parseAbi = __esm({
  "../../enclave/node_modules/abitype/dist/esm/human-readable/parseAbi.js"() {
    init_signatures();
    init_structs();
    init_utils();
  }
});

// ../../enclave/node_modules/abitype/dist/esm/exports/index.js
var init_exports = __esm({
  "../../enclave/node_modules/abitype/dist/esm/exports/index.js"() {
    init_formatAbiItem();
    init_parseAbi();
  }
});

// ../../enclave/node_modules/viem/_esm/utils/abi/formatAbiItem.js
function formatAbiItem2(abiItem, { includeName = false } = {}) {
  if (abiItem.type !== "function" && abiItem.type !== "event" && abiItem.type !== "error")
    throw new InvalidDefinitionTypeError(abiItem.type);
  return `${abiItem.name}(${formatAbiParams(abiItem.inputs, { includeName })})`;
}
function formatAbiParams(params, { includeName = false } = {}) {
  if (!params)
    return "";
  return params.map((param) => formatAbiParam(param, { includeName })).join(includeName ? ", " : ",");
}
function formatAbiParam(param, { includeName }) {
  if (param.type.startsWith("tuple")) {
    return `(${formatAbiParams(param.components, { includeName })})${param.type.slice("tuple".length)}`;
  }
  return param.type + (includeName && param.name ? ` ${param.name}` : "");
}
var init_formatAbiItem2 = __esm({
  "../../enclave/node_modules/viem/_esm/utils/abi/formatAbiItem.js"() {
    init_abi();
  }
});

// ../../enclave/node_modules/viem/_esm/utils/data/isHex.js
function isHex(value, { strict = true } = {}) {
  if (!value)
    return false;
  if (typeof value !== "string")
    return false;
  return strict ? /^0x[0-9a-fA-F]*$/.test(value) : value.startsWith("0x");
}
var init_isHex = __esm({
  "../../enclave/node_modules/viem/_esm/utils/data/isHex.js"() {
  }
});

// ../../enclave/node_modules/viem/_esm/utils/data/size.js
function size(value) {
  if (isHex(value, { strict: false }))
    return Math.ceil((value.length - 2) / 2);
  return value.length;
}
var init_size = __esm({
  "../../enclave/node_modules/viem/_esm/utils/data/size.js"() {
    init_isHex();
  }
});

// ../../enclave/node_modules/viem/_esm/errors/version.js
var version2;
var init_version2 = __esm({
  "../../enclave/node_modules/viem/_esm/errors/version.js"() {
    version2 = "2.53.1";
  }
});

// ../../enclave/node_modules/viem/_esm/errors/base.js
function walk(err, fn) {
  if (fn?.(err))
    return err;
  if (err && typeof err === "object" && "cause" in err && err.cause !== void 0)
    return walk(err.cause, fn);
  return fn ? null : err;
}
var errorConfig, BaseError2;
var init_base = __esm({
  "../../enclave/node_modules/viem/_esm/errors/base.js"() {
    init_version2();
    errorConfig = {
      getDocsUrl: ({ docsBaseUrl, docsPath: docsPath5 = "", docsSlug }) => docsPath5 ? `${docsBaseUrl ?? "https://viem.sh"}${docsPath5}${docsSlug ? `#${docsSlug}` : ""}` : void 0,
      version: `viem@${version2}`
    };
    BaseError2 = class _BaseError extends Error {
      constructor(shortMessage, args = {}) {
        const details = (() => {
          if (args.cause instanceof _BaseError)
            return args.cause.details;
          if (args.cause?.message)
            return args.cause.message;
          return args.details;
        })();
        const docsPath5 = (() => {
          if (args.cause instanceof _BaseError)
            return args.cause.docsPath || args.docsPath;
          return args.docsPath;
        })();
        const docsUrl = errorConfig.getDocsUrl?.({ ...args, docsPath: docsPath5 });
        const message = [
          shortMessage || "An error occurred.",
          "",
          ...args.metaMessages ? [...args.metaMessages, ""] : [],
          ...docsUrl ? [`Docs: ${docsUrl}`] : [],
          ...details ? [`Details: ${details}`] : [],
          ...errorConfig.version ? [`Version: ${errorConfig.version}`] : []
        ].join("\n");
        super(message, args.cause ? { cause: args.cause } : void 0);
        Object.defineProperty(this, "details", {
          enumerable: true,
          configurable: true,
          writable: true,
          value: void 0
        });
        Object.defineProperty(this, "docsPath", {
          enumerable: true,
          configurable: true,
          writable: true,
          value: void 0
        });
        Object.defineProperty(this, "metaMessages", {
          enumerable: true,
          configurable: true,
          writable: true,
          value: void 0
        });
        Object.defineProperty(this, "shortMessage", {
          enumerable: true,
          configurable: true,
          writable: true,
          value: void 0
        });
        Object.defineProperty(this, "version", {
          enumerable: true,
          configurable: true,
          writable: true,
          value: void 0
        });
        Object.defineProperty(this, "name", {
          enumerable: true,
          configurable: true,
          writable: true,
          value: "BaseError"
        });
        this.details = details;
        this.docsPath = docsPath5;
        this.metaMessages = args.metaMessages;
        this.name = args.name ?? this.name;
        this.shortMessage = shortMessage;
        this.version = version2;
      }
      walk(fn) {
        return walk(this, fn);
      }
    };
  }
});

// ../../enclave/node_modules/viem/_esm/errors/abi.js
var AbiDecodingDataSizeTooSmallError, AbiDecodingZeroDataError, AbiEncodingArrayLengthMismatchError, AbiEncodingBytesSizeMismatchError, AbiEncodingLengthMismatchError, AbiEventSignatureEmptyTopicsError, AbiEventSignatureNotFoundError, AbiEventNotFoundError, AbiFunctionNotFoundError, AbiFunctionOutputsNotFoundError, AbiFunctionSignatureNotFoundError, AbiItemAmbiguityError, BytesSizeMismatchError, DecodeLogDataMismatch, DecodeLogTopicsMismatch, InvalidAbiEncodingTypeError, InvalidAbiDecodingTypeError, InvalidArrayError, InvalidDefinitionTypeError;
var init_abi = __esm({
  "../../enclave/node_modules/viem/_esm/errors/abi.js"() {
    init_formatAbiItem2();
    init_size();
    init_base();
    AbiDecodingDataSizeTooSmallError = class extends BaseError2 {
      constructor({ data, params, size: size2 }) {
        super([`Data size of ${size2} bytes is too small for given parameters.`].join("\n"), {
          metaMessages: [
            `Params: (${formatAbiParams(params, { includeName: true })})`,
            `Data:   ${data} (${size2} bytes)`
          ],
          name: "AbiDecodingDataSizeTooSmallError"
        });
        Object.defineProperty(this, "data", {
          enumerable: true,
          configurable: true,
          writable: true,
          value: void 0
        });
        Object.defineProperty(this, "params", {
          enumerable: true,
          configurable: true,
          writable: true,
          value: void 0
        });
        Object.defineProperty(this, "size", {
          enumerable: true,
          configurable: true,
          writable: true,
          value: void 0
        });
        this.data = data;
        this.params = params;
        this.size = size2;
      }
    };
    AbiDecodingZeroDataError = class extends BaseError2 {
      constructor({ cause } = {}) {
        super('Cannot decode zero data ("0x") with ABI parameters.', {
          name: "AbiDecodingZeroDataError",
          cause
        });
      }
    };
    AbiEncodingArrayLengthMismatchError = class extends BaseError2 {
      constructor({ expectedLength, givenLength, type }) {
        super([
          `ABI encoding array length mismatch for type ${type}.`,
          `Expected length: ${expectedLength}`,
          `Given length: ${givenLength}`
        ].join("\n"), { name: "AbiEncodingArrayLengthMismatchError" });
      }
    };
    AbiEncodingBytesSizeMismatchError = class extends BaseError2 {
      constructor({ expectedSize, value }) {
        super(`Size of bytes "${value}" (bytes${size(value)}) does not match expected size (bytes${expectedSize}).`, { name: "AbiEncodingBytesSizeMismatchError" });
      }
    };
    AbiEncodingLengthMismatchError = class extends BaseError2 {
      constructor({ expectedLength, givenLength }) {
        super([
          "ABI encoding params/values length mismatch.",
          `Expected length (params): ${expectedLength}`,
          `Given length (values): ${givenLength}`
        ].join("\n"), { name: "AbiEncodingLengthMismatchError" });
      }
    };
    AbiEventSignatureEmptyTopicsError = class extends BaseError2 {
      constructor({ docsPath: docsPath5 }) {
        super("Cannot extract event signature from empty topics.", {
          docsPath: docsPath5,
          name: "AbiEventSignatureEmptyTopicsError"
        });
      }
    };
    AbiEventSignatureNotFoundError = class extends BaseError2 {
      constructor(signature, { docsPath: docsPath5 }) {
        super([
          `Encoded event signature "${signature}" not found on ABI.`,
          "Make sure you are using the correct ABI and that the event exists on it.",
          `You can look up the signature here: https://4byte.sourcify.dev/?q=${signature}.`
        ].join("\n"), {
          docsPath: docsPath5,
          name: "AbiEventSignatureNotFoundError"
        });
      }
    };
    AbiEventNotFoundError = class extends BaseError2 {
      constructor(eventName, { docsPath: docsPath5 } = {}) {
        super([
          `Event ${eventName ? `"${eventName}" ` : ""}not found on ABI.`,
          "Make sure you are using the correct ABI and that the event exists on it."
        ].join("\n"), {
          docsPath: docsPath5,
          name: "AbiEventNotFoundError"
        });
      }
    };
    AbiFunctionNotFoundError = class extends BaseError2 {
      constructor(functionName, { docsPath: docsPath5 } = {}) {
        super([
          `Function ${functionName ? `"${functionName}" ` : ""}not found on ABI.`,
          "Make sure you are using the correct ABI and that the function exists on it."
        ].join("\n"), {
          docsPath: docsPath5,
          name: "AbiFunctionNotFoundError"
        });
      }
    };
    AbiFunctionOutputsNotFoundError = class extends BaseError2 {
      constructor(functionName, { docsPath: docsPath5 }) {
        super([
          `Function "${functionName}" does not contain any \`outputs\` on ABI.`,
          "Cannot decode function result without knowing what the parameter types are.",
          "Make sure you are using the correct ABI and that the function exists on it."
        ].join("\n"), {
          docsPath: docsPath5,
          name: "AbiFunctionOutputsNotFoundError"
        });
      }
    };
    AbiFunctionSignatureNotFoundError = class extends BaseError2 {
      constructor(signature, { docsPath: docsPath5 }) {
        super([
          `Encoded function signature "${signature}" not found on ABI.`,
          "Make sure you are using the correct ABI and that the function exists on it.",
          `You can look up the signature here: https://4byte.sourcify.dev/?q=${signature}.`
        ].join("\n"), {
          docsPath: docsPath5,
          name: "AbiFunctionSignatureNotFoundError"
        });
      }
    };
    AbiItemAmbiguityError = class extends BaseError2 {
      constructor(x, y) {
        super("Found ambiguous types in overloaded ABI items.", {
          metaMessages: [
            `\`${x.type}\` in \`${formatAbiItem2(x.abiItem)}\`, and`,
            `\`${y.type}\` in \`${formatAbiItem2(y.abiItem)}\``,
            "",
            "These types encode differently and cannot be distinguished at runtime.",
            "Remove one of the ambiguous items in the ABI."
          ],
          name: "AbiItemAmbiguityError"
        });
      }
    };
    BytesSizeMismatchError = class extends BaseError2 {
      constructor({ expectedSize, givenSize }) {
        super(`Expected bytes${expectedSize}, got bytes${givenSize}.`, {
          name: "BytesSizeMismatchError"
        });
      }
    };
    DecodeLogDataMismatch = class extends BaseError2 {
      constructor({ abiItem, data, params, size: size2 }) {
        super([
          `Data size of ${size2} bytes is too small for non-indexed event parameters.`
        ].join("\n"), {
          metaMessages: [
            `Params: (${formatAbiParams(params, { includeName: true })})`,
            `Data:   ${data} (${size2} bytes)`
          ],
          name: "DecodeLogDataMismatch"
        });
        Object.defineProperty(this, "abiItem", {
          enumerable: true,
          configurable: true,
          writable: true,
          value: void 0
        });
        Object.defineProperty(this, "data", {
          enumerable: true,
          configurable: true,
          writable: true,
          value: void 0
        });
        Object.defineProperty(this, "params", {
          enumerable: true,
          configurable: true,
          writable: true,
          value: void 0
        });
        Object.defineProperty(this, "size", {
          enumerable: true,
          configurable: true,
          writable: true,
          value: void 0
        });
        this.abiItem = abiItem;
        this.data = data;
        this.params = params;
        this.size = size2;
      }
    };
    DecodeLogTopicsMismatch = class extends BaseError2 {
      constructor({ abiItem, param }) {
        super([
          `Expected a topic for indexed event parameter${param.name ? ` "${param.name}"` : ""} on event "${formatAbiItem2(abiItem, { includeName: true })}".`
        ].join("\n"), { name: "DecodeLogTopicsMismatch" });
        Object.defineProperty(this, "abiItem", {
          enumerable: true,
          configurable: true,
          writable: true,
          value: void 0
        });
        this.abiItem = abiItem;
      }
    };
    InvalidAbiEncodingTypeError = class extends BaseError2 {
      constructor(type, { docsPath: docsPath5 }) {
        super([
          `Type "${type}" is not a valid encoding type.`,
          "Please provide a valid ABI type."
        ].join("\n"), { docsPath: docsPath5, name: "InvalidAbiEncodingType" });
      }
    };
    InvalidAbiDecodingTypeError = class extends BaseError2 {
      constructor(type, { docsPath: docsPath5 }) {
        super([
          `Type "${type}" is not a valid decoding type.`,
          "Please provide a valid ABI type."
        ].join("\n"), { docsPath: docsPath5, name: "InvalidAbiDecodingType" });
      }
    };
    InvalidArrayError = class extends BaseError2 {
      constructor(value) {
        super([`Value "${value}" is not a valid array.`].join("\n"), {
          name: "InvalidArrayError"
        });
      }
    };
    InvalidDefinitionTypeError = class extends BaseError2 {
      constructor(type) {
        super([
          `"${type}" is not a valid definition type.`,
          'Valid types: "function", "event", "error"'
        ].join("\n"), { name: "InvalidDefinitionTypeError" });
      }
    };
  }
});

// ../../enclave/node_modules/viem/_esm/errors/data.js
var SliceOffsetOutOfBoundsError, SizeExceedsPaddingSizeError;
var init_data = __esm({
  "../../enclave/node_modules/viem/_esm/errors/data.js"() {
    init_base();
    SliceOffsetOutOfBoundsError = class extends BaseError2 {
      constructor({ offset, position, size: size2 }) {
        super(`Slice ${position === "start" ? "starting" : "ending"} at offset "${offset}" is out-of-bounds (size: ${size2}).`, { name: "SliceOffsetOutOfBoundsError" });
      }
    };
    SizeExceedsPaddingSizeError = class extends BaseError2 {
      constructor({ size: size2, targetSize, type }) {
        super(`${type.charAt(0).toUpperCase()}${type.slice(1).toLowerCase()} size (${size2}) exceeds padding size (${targetSize}).`, { name: "SizeExceedsPaddingSizeError" });
      }
    };
  }
});

// ../../enclave/node_modules/viem/_esm/utils/data/pad.js
function pad(hexOrBytes, { dir, size: size2 = 32 } = {}) {
  if (typeof hexOrBytes === "string")
    return padHex(hexOrBytes, { dir, size: size2 });
  return padBytes(hexOrBytes, { dir, size: size2 });
}
function padHex(hex_, { dir, size: size2 = 32 } = {}) {
  if (size2 === null)
    return hex_;
  const hex = hex_.replace("0x", "");
  if (hex.length > size2 * 2)
    throw new SizeExceedsPaddingSizeError({
      size: Math.ceil(hex.length / 2),
      targetSize: size2,
      type: "hex"
    });
  return `0x${hex[dir === "right" ? "padEnd" : "padStart"](size2 * 2, "0")}`;
}
function padBytes(bytes, { dir, size: size2 = 32 } = {}) {
  if (size2 === null)
    return bytes;
  if (bytes.length > size2)
    throw new SizeExceedsPaddingSizeError({
      size: bytes.length,
      targetSize: size2,
      type: "bytes"
    });
  const paddedBytes = new Uint8Array(size2);
  for (let i = 0; i < size2; i++) {
    const padEnd = dir === "right";
    paddedBytes[padEnd ? i : size2 - i - 1] = bytes[padEnd ? i : bytes.length - i - 1];
  }
  return paddedBytes;
}
var init_pad = __esm({
  "../../enclave/node_modules/viem/_esm/utils/data/pad.js"() {
    init_data();
  }
});

// ../../enclave/node_modules/viem/_esm/errors/encoding.js
var IntegerOutOfRangeError, InvalidBytesBooleanError, SizeOverflowError;
var init_encoding = __esm({
  "../../enclave/node_modules/viem/_esm/errors/encoding.js"() {
    init_base();
    IntegerOutOfRangeError = class extends BaseError2 {
      constructor({ max: max2, min, signed, size: size2, value }) {
        super(`Number "${value}" is not in safe ${size2 ? `${size2 * 8}-bit ${signed ? "signed" : "unsigned"} ` : ""}integer range ${max2 ? `(${min} to ${max2})` : `(above ${min})`}`, { name: "IntegerOutOfRangeError" });
      }
    };
    InvalidBytesBooleanError = class extends BaseError2 {
      constructor(bytes) {
        super(`Bytes value "${bytes}" is not a valid boolean. The bytes array must contain a single byte of either a 0 or 1 value.`, {
          name: "InvalidBytesBooleanError"
        });
      }
    };
    SizeOverflowError = class extends BaseError2 {
      constructor({ givenSize, maxSize }) {
        super(`Size cannot exceed ${maxSize} bytes. Given size: ${givenSize} bytes.`, { name: "SizeOverflowError" });
      }
    };
  }
});

// ../../enclave/node_modules/viem/_esm/utils/data/trim.js
function trim(hexOrBytes, { dir = "left" } = {}) {
  let data = typeof hexOrBytes === "string" ? hexOrBytes.replace("0x", "") : hexOrBytes;
  let sliceLength = 0;
  for (let i = 0; i < data.length - 1; i++) {
    if (data[dir === "left" ? i : data.length - i - 1].toString() === "0")
      sliceLength++;
    else
      break;
  }
  data = dir === "left" ? data.slice(sliceLength) : data.slice(0, data.length - sliceLength);
  if (typeof hexOrBytes === "string") {
    if (data.length === 1 && dir === "right")
      data = `${data}0`;
    return `0x${data.length % 2 === 1 ? `0${data}` : data}`;
  }
  return data;
}
var init_trim = __esm({
  "../../enclave/node_modules/viem/_esm/utils/data/trim.js"() {
  }
});

// ../../enclave/node_modules/viem/_esm/utils/encoding/fromHex.js
function assertSize(hexOrBytes, { size: size2 }) {
  if (size(hexOrBytes) > size2)
    throw new SizeOverflowError({
      givenSize: size(hexOrBytes),
      maxSize: size2
    });
}
function hexToBigInt(hex, opts = {}) {
  const { signed } = opts;
  if (opts.size)
    assertSize(hex, { size: opts.size });
  const value = BigInt(hex);
  if (!signed)
    return value;
  const size2 = (hex.length - 2) / 2;
  const max2 = (1n << BigInt(size2) * 8n - 1n) - 1n;
  if (value <= max2)
    return value;
  return value - BigInt(`0x${"f".padStart(size2 * 2, "f")}`) - 1n;
}
function hexToNumber(hex, opts = {}) {
  const value = hexToBigInt(hex, opts);
  const number = Number(value);
  if (!Number.isSafeInteger(number))
    throw new IntegerOutOfRangeError({
      max: `${Number.MAX_SAFE_INTEGER}`,
      min: `${Number.MIN_SAFE_INTEGER}`,
      signed: opts.signed,
      size: opts.size,
      value: `${value}n`
    });
  return number;
}
var init_fromHex = __esm({
  "../../enclave/node_modules/viem/_esm/utils/encoding/fromHex.js"() {
    init_encoding();
    init_size();
  }
});

// ../../enclave/node_modules/viem/_esm/utils/encoding/toHex.js
function toHex(value, opts = {}) {
  if (typeof value === "number" || typeof value === "bigint")
    return numberToHex(value, opts);
  if (typeof value === "string") {
    return stringToHex(value, opts);
  }
  if (typeof value === "boolean")
    return boolToHex(value, opts);
  return bytesToHex(value, opts);
}
function boolToHex(value, opts = {}) {
  const hex = `0x${Number(value)}`;
  if (typeof opts.size === "number") {
    assertSize(hex, { size: opts.size });
    return pad(hex, { size: opts.size });
  }
  return hex;
}
function bytesToHex(value, opts = {}) {
  let string = "";
  for (let i = 0; i < value.length; i++) {
    string += hexes[value[i]];
  }
  const hex = `0x${string}`;
  if (typeof opts.size === "number") {
    assertSize(hex, { size: opts.size });
    return pad(hex, { dir: "right", size: opts.size });
  }
  return hex;
}
function numberToHex(value_, opts = {}) {
  const { signed, size: size2 } = opts;
  const value = BigInt(value_);
  let maxValue;
  if (size2) {
    if (signed)
      maxValue = (1n << BigInt(size2) * 8n - 1n) - 1n;
    else
      maxValue = 2n ** (BigInt(size2) * 8n) - 1n;
  } else if (typeof value_ === "number") {
    maxValue = BigInt(Number.MAX_SAFE_INTEGER);
  }
  const minValue = typeof maxValue === "bigint" && signed ? -maxValue - 1n : 0;
  if (maxValue && value > maxValue || value < minValue) {
    const suffix = typeof value_ === "bigint" ? "n" : "";
    throw new IntegerOutOfRangeError({
      max: maxValue ? `${maxValue}${suffix}` : void 0,
      min: `${minValue}${suffix}`,
      signed,
      size: size2,
      value: `${value_}${suffix}`
    });
  }
  const hex = `0x${(signed && value < 0 ? (1n << BigInt(size2 * 8)) + BigInt(value) : value).toString(16)}`;
  if (size2)
    return pad(hex, { size: size2 });
  return hex;
}
function stringToHex(value_, opts = {}) {
  const value = encoder.encode(value_);
  return bytesToHex(value, opts);
}
var hexes, encoder;
var init_toHex = __esm({
  "../../enclave/node_modules/viem/_esm/utils/encoding/toHex.js"() {
    init_encoding();
    init_pad();
    init_fromHex();
    hexes = /* @__PURE__ */ Array.from({ length: 256 }, (_v, i) => i.toString(16).padStart(2, "0"));
    encoder = /* @__PURE__ */ new TextEncoder();
  }
});

// ../../enclave/node_modules/viem/_esm/utils/encoding/toBytes.js
function toBytes(value, opts = {}) {
  if (typeof value === "number" || typeof value === "bigint")
    return numberToBytes(value, opts);
  if (typeof value === "boolean")
    return boolToBytes(value, opts);
  if (isHex(value))
    return hexToBytes(value, opts);
  return stringToBytes(value, opts);
}
function boolToBytes(value, opts = {}) {
  const bytes = new Uint8Array(1);
  bytes[0] = Number(value);
  if (typeof opts.size === "number") {
    assertSize(bytes, { size: opts.size });
    return pad(bytes, { size: opts.size });
  }
  return bytes;
}
function charCodeToBase16(char) {
  if (char >= charCodeMap.zero && char <= charCodeMap.nine)
    return char - charCodeMap.zero;
  if (char >= charCodeMap.A && char <= charCodeMap.F)
    return char - (charCodeMap.A - 10);
  if (char >= charCodeMap.a && char <= charCodeMap.f)
    return char - (charCodeMap.a - 10);
  return void 0;
}
function hexToBytes(hex_, opts = {}) {
  let hex = hex_;
  if (opts.size) {
    assertSize(hex, { size: opts.size });
    hex = pad(hex, { dir: "right", size: opts.size });
  }
  let hexString = hex.slice(2);
  if (hexString.length % 2)
    hexString = `0${hexString}`;
  const length = hexString.length / 2;
  const bytes = new Uint8Array(length);
  for (let index = 0, j = 0; index < length; index++) {
    const nibbleLeft = charCodeToBase16(hexString.charCodeAt(j++));
    const nibbleRight = charCodeToBase16(hexString.charCodeAt(j++));
    if (nibbleLeft === void 0 || nibbleRight === void 0) {
      throw new BaseError2(`Invalid byte sequence ("${hexString[j - 2]}${hexString[j - 1]}" in "${hexString}").`);
    }
    bytes[index] = nibbleLeft * 16 + nibbleRight;
  }
  return bytes;
}
function numberToBytes(value, opts) {
  const hex = numberToHex(value, opts);
  return hexToBytes(hex);
}
function stringToBytes(value, opts = {}) {
  const bytes = encoder2.encode(value);
  if (typeof opts.size === "number") {
    assertSize(bytes, { size: opts.size });
    return pad(bytes, { dir: "right", size: opts.size });
  }
  return bytes;
}
var encoder2, charCodeMap;
var init_toBytes = __esm({
  "../../enclave/node_modules/viem/_esm/utils/encoding/toBytes.js"() {
    init_base();
    init_isHex();
    init_pad();
    init_fromHex();
    init_toHex();
    encoder2 = /* @__PURE__ */ new TextEncoder();
    charCodeMap = {
      zero: 48,
      nine: 57,
      A: 65,
      F: 70,
      a: 97,
      f: 102
    };
  }
});

// ../../enclave/node_modules/@noble/hashes/esm/_u64.js
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
var U32_MASK64, _32n, rotlSH, rotlSL, rotlBH, rotlBL;
var init_u64 = __esm({
  "../../enclave/node_modules/@noble/hashes/esm/_u64.js"() {
    U32_MASK64 = /* @__PURE__ */ BigInt(2 ** 32 - 1);
    _32n = /* @__PURE__ */ BigInt(32);
    rotlSH = (h, l, s) => h << s | l >>> 32 - s;
    rotlSL = (h, l, s) => l << s | h >>> 32 - s;
    rotlBH = (h, l, s) => l << s - 32 | h >>> 64 - s;
    rotlBL = (h, l, s) => h << s - 32 | l >>> 64 - s;
  }
});

// ../../enclave/node_modules/@noble/hashes/esm/crypto.js
var crypto;
var init_crypto = __esm({
  "../../enclave/node_modules/@noble/hashes/esm/crypto.js"() {
    crypto = typeof globalThis === "object" && "crypto" in globalThis ? globalThis.crypto : void 0;
  }
});

// ../../enclave/node_modules/@noble/hashes/esm/utils.js
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
function u32(arr) {
  return new Uint32Array(arr.buffer, arr.byteOffset, Math.floor(arr.byteLength / 4));
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
function byteSwap(word) {
  return word << 24 & 4278190080 | word << 8 & 16711680 | word >>> 8 & 65280 | word >>> 24 & 255;
}
function byteSwap32(arr) {
  for (let i = 0; i < arr.length; i++) {
    arr[i] = byteSwap(arr[i]);
  }
  return arr;
}
function utf8ToBytes(str2) {
  if (typeof str2 !== "string")
    throw new Error("string expected");
  return new Uint8Array(new TextEncoder().encode(str2));
}
function toBytes2(data) {
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
  for (let i = 0, pad2 = 0; i < arrays.length; i++) {
    const a = arrays[i];
    res.set(a, pad2);
    pad2 += a.length;
  }
  return res;
}
function createHasher(hashCons) {
  const hashC = (msg) => hashCons().update(toBytes2(msg)).digest();
  const tmp = hashCons();
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.create = () => hashCons();
  return hashC;
}
function randomBytes(bytesLength = 32) {
  if (crypto && typeof crypto.getRandomValues === "function") {
    return crypto.getRandomValues(new Uint8Array(bytesLength));
  }
  if (crypto && typeof crypto.randomBytes === "function") {
    return Uint8Array.from(crypto.randomBytes(bytesLength));
  }
  throw new Error("crypto.getRandomValues must be defined");
}
var isLE, swap32IfBE, Hash;
var init_utils2 = __esm({
  "../../enclave/node_modules/@noble/hashes/esm/utils.js"() {
    init_crypto();
    isLE = /* @__PURE__ */ (() => new Uint8Array(new Uint32Array([287454020]).buffer)[0] === 68)();
    swap32IfBE = isLE ? (u) => u : byteSwap32;
    Hash = class {
    };
  }
});

// ../../enclave/node_modules/@noble/hashes/esm/sha3.js
function keccakP(s, rounds = 24) {
  const B = new Uint32Array(5 * 2);
  for (let round = 24 - rounds; round < 24; round++) {
    for (let x = 0; x < 10; x++)
      B[x] = s[x] ^ s[x + 10] ^ s[x + 20] ^ s[x + 30] ^ s[x + 40];
    for (let x = 0; x < 10; x += 2) {
      const idx1 = (x + 8) % 10;
      const idx0 = (x + 2) % 10;
      const B0 = B[idx0];
      const B1 = B[idx0 + 1];
      const Th = rotlH(B0, B1, 1) ^ B[idx1];
      const Tl = rotlL(B0, B1, 1) ^ B[idx1 + 1];
      for (let y = 0; y < 50; y += 10) {
        s[x + y] ^= Th;
        s[x + y + 1] ^= Tl;
      }
    }
    let curH = s[2];
    let curL = s[3];
    for (let t = 0; t < 24; t++) {
      const shift = SHA3_ROTL[t];
      const Th = rotlH(curH, curL, shift);
      const Tl = rotlL(curH, curL, shift);
      const PI = SHA3_PI[t];
      curH = s[PI];
      curL = s[PI + 1];
      s[PI] = Th;
      s[PI + 1] = Tl;
    }
    for (let y = 0; y < 50; y += 10) {
      for (let x = 0; x < 10; x++)
        B[x] = s[y + x];
      for (let x = 0; x < 10; x++)
        s[y + x] ^= ~B[(x + 2) % 10] & B[(x + 4) % 10];
    }
    s[0] ^= SHA3_IOTA_H[round];
    s[1] ^= SHA3_IOTA_L[round];
  }
  clean(B);
}
var _0n, _1n, _2n, _7n, _256n, _0x71n, SHA3_PI, SHA3_ROTL, _SHA3_IOTA, IOTAS, SHA3_IOTA_H, SHA3_IOTA_L, rotlH, rotlL, Keccak, gen, keccak_256;
var init_sha3 = __esm({
  "../../enclave/node_modules/@noble/hashes/esm/sha3.js"() {
    init_u64();
    init_utils2();
    _0n = BigInt(0);
    _1n = BigInt(1);
    _2n = BigInt(2);
    _7n = BigInt(7);
    _256n = BigInt(256);
    _0x71n = BigInt(113);
    SHA3_PI = [];
    SHA3_ROTL = [];
    _SHA3_IOTA = [];
    for (let round = 0, R = _1n, x = 1, y = 0; round < 24; round++) {
      [x, y] = [y, (2 * x + 3 * y) % 5];
      SHA3_PI.push(2 * (5 * y + x));
      SHA3_ROTL.push((round + 1) * (round + 2) / 2 % 64);
      let t = _0n;
      for (let j = 0; j < 7; j++) {
        R = (R << _1n ^ (R >> _7n) * _0x71n) % _256n;
        if (R & _2n)
          t ^= _1n << (_1n << /* @__PURE__ */ BigInt(j)) - _1n;
      }
      _SHA3_IOTA.push(t);
    }
    IOTAS = split(_SHA3_IOTA, true);
    SHA3_IOTA_H = IOTAS[0];
    SHA3_IOTA_L = IOTAS[1];
    rotlH = (h, l, s) => s > 32 ? rotlBH(h, l, s) : rotlSH(h, l, s);
    rotlL = (h, l, s) => s > 32 ? rotlBL(h, l, s) : rotlSL(h, l, s);
    Keccak = class _Keccak extends Hash {
      // NOTE: we accept arguments in bytes instead of bits here.
      constructor(blockLen, suffix, outputLen, enableXOF = false, rounds = 24) {
        super();
        this.pos = 0;
        this.posOut = 0;
        this.finished = false;
        this.destroyed = false;
        this.enableXOF = false;
        this.blockLen = blockLen;
        this.suffix = suffix;
        this.outputLen = outputLen;
        this.enableXOF = enableXOF;
        this.rounds = rounds;
        anumber(outputLen);
        if (!(0 < blockLen && blockLen < 200))
          throw new Error("only keccak-f1600 function is supported");
        this.state = new Uint8Array(200);
        this.state32 = u32(this.state);
      }
      clone() {
        return this._cloneInto();
      }
      keccak() {
        swap32IfBE(this.state32);
        keccakP(this.state32, this.rounds);
        swap32IfBE(this.state32);
        this.posOut = 0;
        this.pos = 0;
      }
      update(data) {
        aexists(this);
        data = toBytes2(data);
        abytes(data);
        const { blockLen, state } = this;
        const len = data.length;
        for (let pos = 0; pos < len; ) {
          const take = Math.min(blockLen - this.pos, len - pos);
          for (let i = 0; i < take; i++)
            state[this.pos++] ^= data[pos++];
          if (this.pos === blockLen)
            this.keccak();
        }
        return this;
      }
      finish() {
        if (this.finished)
          return;
        this.finished = true;
        const { state, suffix, pos, blockLen } = this;
        state[pos] ^= suffix;
        if ((suffix & 128) !== 0 && pos === blockLen - 1)
          this.keccak();
        state[blockLen - 1] ^= 128;
        this.keccak();
      }
      writeInto(out) {
        aexists(this, false);
        abytes(out);
        this.finish();
        const bufferOut = this.state;
        const { blockLen } = this;
        for (let pos = 0, len = out.length; pos < len; ) {
          if (this.posOut >= blockLen)
            this.keccak();
          const take = Math.min(blockLen - this.posOut, len - pos);
          out.set(bufferOut.subarray(this.posOut, this.posOut + take), pos);
          this.posOut += take;
          pos += take;
        }
        return out;
      }
      xofInto(out) {
        if (!this.enableXOF)
          throw new Error("XOF is not possible for this instance");
        return this.writeInto(out);
      }
      xof(bytes) {
        anumber(bytes);
        return this.xofInto(new Uint8Array(bytes));
      }
      digestInto(out) {
        aoutput(out, this);
        if (this.finished)
          throw new Error("digest() was already called");
        this.writeInto(out);
        this.destroy();
        return out;
      }
      digest() {
        return this.digestInto(new Uint8Array(this.outputLen));
      }
      destroy() {
        this.destroyed = true;
        clean(this.state);
      }
      _cloneInto(to) {
        const { blockLen, suffix, outputLen, rounds, enableXOF } = this;
        to || (to = new _Keccak(blockLen, suffix, outputLen, enableXOF, rounds));
        to.state32.set(this.state32);
        to.pos = this.pos;
        to.posOut = this.posOut;
        to.finished = this.finished;
        to.rounds = rounds;
        to.suffix = suffix;
        to.outputLen = outputLen;
        to.enableXOF = enableXOF;
        to.destroyed = this.destroyed;
        return to;
      }
    };
    gen = (suffix, blockLen, outputLen) => createHasher(() => new Keccak(blockLen, suffix, outputLen));
    keccak_256 = /* @__PURE__ */ (() => gen(1, 136, 256 / 8))();
  }
});

// ../../enclave/node_modules/viem/_esm/utils/hash/keccak256.js
function keccak256(value, to_) {
  const to = to_ || "hex";
  const bytes = keccak_256(isHex(value, { strict: false }) ? toBytes(value) : value);
  if (to === "bytes")
    return bytes;
  return toHex(bytes);
}
var init_keccak256 = __esm({
  "../../enclave/node_modules/viem/_esm/utils/hash/keccak256.js"() {
    init_sha3();
    init_isHex();
    init_toBytes();
    init_toHex();
  }
});

// ../../enclave/node_modules/viem/_esm/utils/hash/hashSignature.js
function hashSignature(sig) {
  return hash(sig);
}
var hash;
var init_hashSignature = __esm({
  "../../enclave/node_modules/viem/_esm/utils/hash/hashSignature.js"() {
    init_toBytes();
    init_keccak256();
    hash = (value) => keccak256(toBytes(value));
  }
});

// ../../enclave/node_modules/viem/_esm/utils/hash/normalizeSignature.js
function normalizeSignature(signature) {
  let active = true;
  let current = "";
  let level = 0;
  let result = "";
  let valid = false;
  for (let i = 0; i < signature.length; i++) {
    const char = signature[i];
    if (["(", ")", ","].includes(char))
      active = true;
    if (char === "(")
      level++;
    if (char === ")")
      level--;
    if (!active)
      continue;
    if (level === 0) {
      if (char === " " && ["event", "function", ""].includes(result))
        result = "";
      else {
        result += char;
        if (char === ")") {
          valid = true;
          break;
        }
      }
      continue;
    }
    if (char === " ") {
      if (signature[i - 1] !== "," && current !== "," && current !== ",(") {
        current = "";
        active = false;
      }
      continue;
    }
    result += char;
    current += char;
  }
  if (!valid)
    throw new BaseError2("Unable to normalize signature.");
  return result;
}
var init_normalizeSignature = __esm({
  "../../enclave/node_modules/viem/_esm/utils/hash/normalizeSignature.js"() {
    init_base();
  }
});

// ../../enclave/node_modules/viem/_esm/utils/hash/toSignature.js
var toSignature;
var init_toSignature = __esm({
  "../../enclave/node_modules/viem/_esm/utils/hash/toSignature.js"() {
    init_exports();
    init_normalizeSignature();
    toSignature = (def) => {
      const def_ = (() => {
        if (typeof def === "string")
          return def;
        return formatAbiItem(def);
      })();
      return normalizeSignature(def_);
    };
  }
});

// ../../enclave/node_modules/viem/_esm/utils/hash/toSignatureHash.js
function toSignatureHash(fn) {
  return hashSignature(toSignature(fn));
}
var init_toSignatureHash = __esm({
  "../../enclave/node_modules/viem/_esm/utils/hash/toSignatureHash.js"() {
    init_hashSignature();
    init_toSignature();
  }
});

// ../../enclave/node_modules/viem/_esm/utils/hash/toEventSelector.js
var toEventSelector;
var init_toEventSelector = __esm({
  "../../enclave/node_modules/viem/_esm/utils/hash/toEventSelector.js"() {
    init_toSignatureHash();
    toEventSelector = toSignatureHash;
  }
});

// ../../enclave/node_modules/viem/_esm/errors/address.js
var InvalidAddressError;
var init_address = __esm({
  "../../enclave/node_modules/viem/_esm/errors/address.js"() {
    init_base();
    InvalidAddressError = class extends BaseError2 {
      constructor({ address }) {
        super(`Address "${address}" is invalid.`, {
          metaMessages: [
            "- Address must be a hex value of 20 bytes (40 hex characters).",
            "- Address must match its checksum counterpart."
          ],
          name: "InvalidAddressError"
        });
      }
    };
  }
});

// ../../enclave/node_modules/viem/_esm/utils/lru.js
var LruMap;
var init_lru = __esm({
  "../../enclave/node_modules/viem/_esm/utils/lru.js"() {
    LruMap = class extends Map {
      constructor(size2) {
        super();
        Object.defineProperty(this, "maxSize", {
          enumerable: true,
          configurable: true,
          writable: true,
          value: void 0
        });
        this.maxSize = size2;
      }
      get(key) {
        const value = super.get(key);
        if (super.has(key)) {
          super.delete(key);
          super.set(key, value);
        }
        return value;
      }
      set(key, value) {
        if (super.has(key))
          super.delete(key);
        super.set(key, value);
        if (this.maxSize && this.size > this.maxSize) {
          const firstKey = super.keys().next().value;
          if (firstKey !== void 0)
            super.delete(firstKey);
        }
        return this;
      }
    };
  }
});

// ../../enclave/node_modules/viem/_esm/utils/address/getAddress.js
function checksumAddress(address_, chainId) {
  if (checksumAddressCache.has(`${address_}.${chainId}`))
    return checksumAddressCache.get(`${address_}.${chainId}`);
  const hexAddress = chainId ? `${chainId}${address_.toLowerCase()}` : address_.substring(2).toLowerCase();
  const hash2 = keccak256(stringToBytes(hexAddress), "bytes");
  const address = (chainId ? hexAddress.substring(`${chainId}0x`.length) : hexAddress).split("");
  for (let i = 0; i < 40; i += 2) {
    if (hash2[i >> 1] >> 4 >= 8 && address[i]) {
      address[i] = address[i].toUpperCase();
    }
    if ((hash2[i >> 1] & 15) >= 8 && address[i + 1]) {
      address[i + 1] = address[i + 1].toUpperCase();
    }
  }
  const result = `0x${address.join("")}`;
  checksumAddressCache.set(`${address_}.${chainId}`, result);
  return result;
}
function getAddress(address, chainId) {
  if (!isAddress(address, { strict: false }))
    throw new InvalidAddressError({ address });
  return checksumAddress(address, chainId);
}
var checksumAddressCache;
var init_getAddress = __esm({
  "../../enclave/node_modules/viem/_esm/utils/address/getAddress.js"() {
    init_address();
    init_toBytes();
    init_keccak256();
    init_lru();
    init_isAddress();
    checksumAddressCache = /* @__PURE__ */ new LruMap(8192);
  }
});

// ../../enclave/node_modules/viem/_esm/utils/address/isAddress.js
function isAddress(address, options) {
  const { strict = true } = options ?? {};
  const cacheKey = `${address}.${strict}`;
  if (isAddressCache.has(cacheKey))
    return isAddressCache.get(cacheKey);
  const result = (() => {
    if (!addressRegex.test(address))
      return false;
    if (address.toLowerCase() === address)
      return true;
    if (strict)
      return checksumAddress(address) === address;
    return true;
  })();
  isAddressCache.set(cacheKey, result);
  return result;
}
var addressRegex, isAddressCache;
var init_isAddress = __esm({
  "../../enclave/node_modules/viem/_esm/utils/address/isAddress.js"() {
    init_lru();
    init_getAddress();
    addressRegex = /^0x[a-fA-F0-9]{40}$/;
    isAddressCache = /* @__PURE__ */ new LruMap(8192);
  }
});

// ../../enclave/node_modules/viem/_esm/utils/data/concat.js
function concat(values) {
  if (typeof values[0] === "string")
    return concatHex(values);
  return concatBytes2(values);
}
function concatBytes2(values) {
  let length = 0;
  for (const arr of values) {
    length += arr.length;
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const arr of values) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}
function concatHex(values) {
  return `0x${values.reduce((acc, x) => acc + x.replace("0x", ""), "")}`;
}
var init_concat = __esm({
  "../../enclave/node_modules/viem/_esm/utils/data/concat.js"() {
  }
});

// ../../enclave/node_modules/viem/_esm/utils/data/slice.js
function slice(value, start, end, { strict } = {}) {
  if (isHex(value, { strict: false }))
    return sliceHex(value, start, end, {
      strict
    });
  return sliceBytes(value, start, end, {
    strict
  });
}
function assertStartOffset(value, start) {
  if (typeof start === "number" && start > 0 && start > size(value) - 1)
    throw new SliceOffsetOutOfBoundsError({
      offset: start,
      position: "start",
      size: size(value)
    });
}
function assertEndOffset(value, start, end) {
  if (typeof start === "number" && typeof end === "number" && size(value) !== end - start) {
    throw new SliceOffsetOutOfBoundsError({
      offset: end,
      position: "end",
      size: size(value)
    });
  }
}
function sliceBytes(value_, start, end, { strict } = {}) {
  assertStartOffset(value_, start);
  const value = value_.slice(start, end);
  if (strict)
    assertEndOffset(value, start, end);
  return value;
}
function sliceHex(value_, start, end, { strict } = {}) {
  assertStartOffset(value_, start);
  const value = `0x${value_.replace("0x", "").slice((start ?? 0) * 2, (end ?? value_.length) * 2)}`;
  if (strict)
    assertEndOffset(value, start, end);
  return value;
}
var init_slice = __esm({
  "../../enclave/node_modules/viem/_esm/utils/data/slice.js"() {
    init_data();
    init_isHex();
    init_size();
  }
});

// ../../enclave/node_modules/viem/_esm/utils/regex.js
var bytesRegex2, integerRegex2;
var init_regex2 = __esm({
  "../../enclave/node_modules/viem/_esm/utils/regex.js"() {
    bytesRegex2 = /^bytes([1-9]|1[0-9]|2[0-9]|3[0-2])?$/;
    integerRegex2 = /^(u?int)(8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)?$/;
  }
});

// ../../enclave/node_modules/viem/_esm/utils/abi/encodeAbiParameters.js
function encodeAbiParameters(params, values) {
  if (params.length !== values.length)
    throw new AbiEncodingLengthMismatchError({
      expectedLength: params.length,
      givenLength: values.length
    });
  const preparedParams = prepareParams({
    params,
    values
  });
  const data = encodeParams(preparedParams);
  if (data.length === 0)
    return "0x";
  return data;
}
function prepareParams({ params, values }) {
  const preparedParams = [];
  for (let i = 0; i < params.length; i++) {
    preparedParams.push(prepareParam({ param: params[i], value: values[i] }));
  }
  return preparedParams;
}
function prepareParam({ param, value }) {
  const arrayComponents = getArrayComponents(param.type);
  if (arrayComponents) {
    const [length, type] = arrayComponents;
    return encodeArray(value, { length, param: { ...param, type } });
  }
  if (param.type === "tuple") {
    return encodeTuple(value, {
      param
    });
  }
  if (param.type === "address") {
    return encodeAddress(value);
  }
  if (param.type === "bool") {
    return encodeBool(value);
  }
  if (param.type.startsWith("uint") || param.type.startsWith("int")) {
    const signed = param.type.startsWith("int");
    const [, , size2 = "256"] = integerRegex2.exec(param.type) ?? [];
    return encodeNumber(value, {
      signed,
      size: Number(size2)
    });
  }
  if (param.type.startsWith("bytes")) {
    return encodeBytes(value, { param });
  }
  if (param.type === "string") {
    return encodeString(value);
  }
  throw new InvalidAbiEncodingTypeError(param.type, {
    docsPath: "/docs/contract/encodeAbiParameters"
  });
}
function encodeParams(preparedParams) {
  let staticSize = 0;
  for (let i = 0; i < preparedParams.length; i++) {
    const { dynamic, encoded } = preparedParams[i];
    if (dynamic)
      staticSize += 32;
    else
      staticSize += size(encoded);
  }
  const staticParams = [];
  const dynamicParams = [];
  let dynamicSize = 0;
  for (let i = 0; i < preparedParams.length; i++) {
    const { dynamic, encoded } = preparedParams[i];
    if (dynamic) {
      staticParams.push(numberToHex(staticSize + dynamicSize, { size: 32 }));
      dynamicParams.push(encoded);
      dynamicSize += size(encoded);
    } else {
      staticParams.push(encoded);
    }
  }
  return concat([...staticParams, ...dynamicParams]);
}
function encodeAddress(value) {
  if (!isAddress(value))
    throw new InvalidAddressError({ address: value });
  return { dynamic: false, encoded: padHex(value.toLowerCase()) };
}
function encodeArray(value, { length, param }) {
  const dynamic = length === null;
  if (!Array.isArray(value))
    throw new InvalidArrayError(value);
  if (!dynamic && value.length !== length)
    throw new AbiEncodingArrayLengthMismatchError({
      expectedLength: length,
      givenLength: value.length,
      type: `${param.type}[${length}]`
    });
  let dynamicChild = false;
  const preparedParams = [];
  for (let i = 0; i < value.length; i++) {
    const preparedParam = prepareParam({ param, value: value[i] });
    if (preparedParam.dynamic)
      dynamicChild = true;
    preparedParams.push(preparedParam);
  }
  if (dynamic || dynamicChild) {
    const data = encodeParams(preparedParams);
    if (dynamic) {
      const length2 = numberToHex(preparedParams.length, { size: 32 });
      return {
        dynamic: true,
        encoded: preparedParams.length > 0 ? concat([length2, data]) : length2
      };
    }
    if (dynamicChild)
      return { dynamic: true, encoded: data };
  }
  return {
    dynamic: false,
    encoded: concat(preparedParams.map(({ encoded }) => encoded))
  };
}
function encodeBytes(value, { param }) {
  const [, paramSize] = param.type.split("bytes");
  const bytesSize = size(value);
  if (!paramSize) {
    let value_ = value;
    if (bytesSize % 32 !== 0)
      value_ = padHex(value_, {
        dir: "right",
        size: Math.ceil((value.length - 2) / 2 / 32) * 32
      });
    return {
      dynamic: true,
      encoded: concat([padHex(numberToHex(bytesSize, { size: 32 })), value_])
    };
  }
  if (bytesSize !== Number.parseInt(paramSize, 10))
    throw new AbiEncodingBytesSizeMismatchError({
      expectedSize: Number.parseInt(paramSize, 10),
      value
    });
  return { dynamic: false, encoded: padHex(value, { dir: "right" }) };
}
function encodeBool(value) {
  if (typeof value !== "boolean")
    throw new BaseError2(`Invalid boolean value: "${value}" (type: ${typeof value}). Expected: \`true\` or \`false\`.`);
  return { dynamic: false, encoded: padHex(boolToHex(value)) };
}
function encodeNumber(value, { signed, size: size2 = 256 }) {
  if (typeof size2 === "number") {
    const max2 = 2n ** (BigInt(size2) - (signed ? 1n : 0n)) - 1n;
    const min = signed ? -max2 - 1n : 0n;
    if (value > max2 || value < min)
      throw new IntegerOutOfRangeError({
        max: max2.toString(),
        min: min.toString(),
        signed,
        size: size2 / 8,
        value: value.toString()
      });
  }
  return {
    dynamic: false,
    encoded: numberToHex(value, {
      size: 32,
      signed
    })
  };
}
function encodeString(value) {
  const hexValue = stringToHex(value);
  const partsLength = Math.ceil(size(hexValue) / 32);
  const parts = [];
  for (let i = 0; i < partsLength; i++) {
    parts.push(padHex(slice(hexValue, i * 32, (i + 1) * 32), {
      dir: "right"
    }));
  }
  return {
    dynamic: true,
    encoded: concat([
      padHex(numberToHex(size(hexValue), { size: 32 })),
      ...parts
    ])
  };
}
function encodeTuple(value, { param }) {
  let dynamic = false;
  const preparedParams = [];
  for (let i = 0; i < param.components.length; i++) {
    const param_ = param.components[i];
    const index = Array.isArray(value) ? i : param_.name;
    const preparedParam = prepareParam({
      param: param_,
      value: value[index]
    });
    preparedParams.push(preparedParam);
    if (preparedParam.dynamic)
      dynamic = true;
  }
  return {
    dynamic,
    encoded: dynamic ? encodeParams(preparedParams) : concat(preparedParams.map(({ encoded }) => encoded))
  };
}
function getArrayComponents(type) {
  const matches = type.match(/^(.*)\[(\d+)?\]$/);
  return matches ? (
    // Return `null` if the array is dynamic.
    [matches[2] ? Number(matches[2]) : null, matches[1]]
  ) : void 0;
}
var init_encodeAbiParameters = __esm({
  "../../enclave/node_modules/viem/_esm/utils/abi/encodeAbiParameters.js"() {
    init_abi();
    init_address();
    init_base();
    init_encoding();
    init_isAddress();
    init_concat();
    init_pad();
    init_size();
    init_slice();
    init_toHex();
    init_regex2();
  }
});

// ../../enclave/node_modules/viem/_esm/utils/hash/toFunctionSelector.js
var toFunctionSelector;
var init_toFunctionSelector = __esm({
  "../../enclave/node_modules/viem/_esm/utils/hash/toFunctionSelector.js"() {
    init_slice();
    init_toSignatureHash();
    toFunctionSelector = (fn) => slice(toSignatureHash(fn), 0, 4);
  }
});

// ../../enclave/node_modules/viem/_esm/utils/abi/getAbiItem.js
function getAbiItem(parameters) {
  const { abi, args = [], name } = parameters;
  const isSelector = isHex(name, { strict: false });
  const abiItems = abi.filter((abiItem) => {
    if (isSelector) {
      if (abiItem.type === "function")
        return toFunctionSelector(abiItem) === name;
      if (abiItem.type === "event")
        return toEventSelector(abiItem) === name;
      return false;
    }
    return "name" in abiItem && abiItem.name === name;
  });
  if (abiItems.length === 0)
    return void 0;
  if (abiItems.length === 1)
    return abiItems[0];
  let matchedAbiItem;
  for (const abiItem of abiItems) {
    if (!("inputs" in abiItem))
      continue;
    if (!args || args.length === 0) {
      if (!abiItem.inputs || abiItem.inputs.length === 0)
        return abiItem;
      continue;
    }
    if (!abiItem.inputs)
      continue;
    if (abiItem.inputs.length === 0)
      continue;
    if (abiItem.inputs.length !== args.length)
      continue;
    const matched = args.every((arg, index) => {
      const abiParameter = "inputs" in abiItem && abiItem.inputs[index];
      if (!abiParameter)
        return false;
      return isArgOfType(arg, abiParameter);
    });
    if (matched) {
      if (matchedAbiItem && "inputs" in matchedAbiItem && matchedAbiItem.inputs) {
        const ambiguousTypes = getAmbiguousTypes(abiItem.inputs, matchedAbiItem.inputs, args);
        if (ambiguousTypes)
          throw new AbiItemAmbiguityError({
            abiItem,
            type: ambiguousTypes[0]
          }, {
            abiItem: matchedAbiItem,
            type: ambiguousTypes[1]
          });
      }
      matchedAbiItem = abiItem;
    }
  }
  if (matchedAbiItem)
    return matchedAbiItem;
  return abiItems[0];
}
function isArgOfType(arg, abiParameter) {
  const argType = typeof arg;
  const abiParameterType = abiParameter.type;
  switch (abiParameterType) {
    case "address":
      return isAddress(arg, { strict: false });
    case "bool":
      return argType === "boolean";
    case "function":
      return argType === "string";
    case "string":
      return argType === "string";
    default: {
      if (abiParameterType === "tuple" && "components" in abiParameter)
        return Object.values(abiParameter.components).every((component, index) => {
          return argType === "object" && isArgOfType(Object.values(arg)[index], component);
        });
      if (/^u?int(8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)?$/.test(abiParameterType))
        return argType === "number" || argType === "bigint";
      if (/^bytes([1-9]|1[0-9]|2[0-9]|3[0-2])?$/.test(abiParameterType))
        return argType === "string" || arg instanceof Uint8Array;
      if (/[a-z]+[1-9]{0,3}(\[[0-9]{0,}\])+$/.test(abiParameterType)) {
        return Array.isArray(arg) && arg.every((x) => isArgOfType(x, {
          ...abiParameter,
          // Pop off `[]` or `[M]` from end of type
          type: abiParameterType.replace(/(\[[0-9]{0,}\])$/, "")
        }));
      }
      return false;
    }
  }
}
function getAmbiguousTypes(sourceParameters, targetParameters, args) {
  for (const parameterIndex in sourceParameters) {
    const sourceParameter = sourceParameters[parameterIndex];
    const targetParameter = targetParameters[parameterIndex];
    if (sourceParameter.type === "tuple" && targetParameter.type === "tuple" && "components" in sourceParameter && "components" in targetParameter)
      return getAmbiguousTypes(sourceParameter.components, targetParameter.components, args[parameterIndex]);
    const types = [sourceParameter.type, targetParameter.type];
    const ambiguous = (() => {
      if (types.includes("address") && types.includes("bytes20"))
        return true;
      if (types.includes("address") && types.includes("string"))
        return isAddress(args[parameterIndex], { strict: false });
      if (types.includes("address") && types.includes("bytes"))
        return isAddress(args[parameterIndex], { strict: false });
      return false;
    })();
    if (ambiguous)
      return types;
  }
  return;
}
var init_getAbiItem = __esm({
  "../../enclave/node_modules/viem/_esm/utils/abi/getAbiItem.js"() {
    init_abi();
    init_isHex();
    init_isAddress();
    init_toEventSelector();
    init_toFunctionSelector();
  }
});

// ../../enclave/node_modules/viem/_esm/utils/abi/prepareEncodeFunctionData.js
function prepareEncodeFunctionData(parameters) {
  const { abi, args, functionName } = parameters;
  let abiItem = abi[0];
  if (functionName) {
    const item = getAbiItem({
      abi,
      args,
      name: functionName
    });
    if (!item)
      throw new AbiFunctionNotFoundError(functionName, { docsPath: docsPath2 });
    abiItem = item;
  }
  if (abiItem.type !== "function")
    throw new AbiFunctionNotFoundError(void 0, { docsPath: docsPath2 });
  return {
    abi: [abiItem],
    functionName: toFunctionSelector(formatAbiItem2(abiItem))
  };
}
var docsPath2;
var init_prepareEncodeFunctionData = __esm({
  "../../enclave/node_modules/viem/_esm/utils/abi/prepareEncodeFunctionData.js"() {
    init_abi();
    init_toFunctionSelector();
    init_formatAbiItem2();
    init_getAbiItem();
    docsPath2 = "/docs/contract/encodeFunctionData";
  }
});

// ../../enclave/node_modules/viem/_esm/utils/abi/encodeFunctionData.js
function encodeFunctionData(parameters) {
  const { args } = parameters;
  const { abi, functionName } = (() => {
    if (parameters.abi.length === 1 && parameters.functionName?.startsWith("0x"))
      return parameters;
    return prepareEncodeFunctionData(parameters);
  })();
  const abiItem = abi[0];
  const signature = functionName;
  const data = "inputs" in abiItem && abiItem.inputs ? encodeAbiParameters(abiItem.inputs, args ?? []) : void 0;
  return concatHex([signature, data ?? "0x"]);
}
var init_encodeFunctionData = __esm({
  "../../enclave/node_modules/viem/_esm/utils/abi/encodeFunctionData.js"() {
    init_concat();
    init_encodeAbiParameters();
    init_prepareEncodeFunctionData();
  }
});

// ../../enclave/node_modules/viem/_esm/errors/cursor.js
var NegativeOffsetError, PositionOutOfBoundsError, RecursiveReadLimitExceededError;
var init_cursor = __esm({
  "../../enclave/node_modules/viem/_esm/errors/cursor.js"() {
    init_base();
    NegativeOffsetError = class extends BaseError2 {
      constructor({ offset }) {
        super(`Offset \`${offset}\` cannot be negative.`, {
          name: "NegativeOffsetError"
        });
      }
    };
    PositionOutOfBoundsError = class extends BaseError2 {
      constructor({ length, position }) {
        super(`Position \`${position}\` is out of bounds (\`0 < position < ${length}\`).`, { name: "PositionOutOfBoundsError" });
      }
    };
    RecursiveReadLimitExceededError = class extends BaseError2 {
      constructor({ count, limit }) {
        super(`Recursive read limit of \`${limit}\` exceeded (recursive read count: \`${count}\`).`, { name: "RecursiveReadLimitExceededError" });
      }
    };
  }
});

// ../../enclave/node_modules/viem/_esm/utils/cursor.js
function createCursor(bytes, { recursiveReadLimit = 8192 } = {}) {
  const cursor = Object.create(staticCursor);
  cursor.bytes = bytes;
  cursor.dataView = new DataView(bytes.buffer ?? bytes, bytes.byteOffset, bytes.byteLength);
  cursor.positionReadCount = /* @__PURE__ */ new Map();
  cursor.recursiveReadLimit = recursiveReadLimit;
  return cursor;
}
var staticCursor;
var init_cursor2 = __esm({
  "../../enclave/node_modules/viem/_esm/utils/cursor.js"() {
    init_cursor();
    staticCursor = {
      bytes: new Uint8Array(),
      dataView: new DataView(new ArrayBuffer(0)),
      position: 0,
      positionReadCount: /* @__PURE__ */ new Map(),
      recursiveReadCount: 0,
      recursiveReadLimit: Number.POSITIVE_INFINITY,
      assertReadLimit() {
        if (this.recursiveReadCount >= this.recursiveReadLimit)
          throw new RecursiveReadLimitExceededError({
            count: this.recursiveReadCount + 1,
            limit: this.recursiveReadLimit
          });
      },
      assertPosition(position) {
        if (position < 0 || position > this.bytes.length - 1)
          throw new PositionOutOfBoundsError({
            length: this.bytes.length,
            position
          });
      },
      decrementPosition(offset) {
        if (offset < 0)
          throw new NegativeOffsetError({ offset });
        const position = this.position - offset;
        this.assertPosition(position);
        this.position = position;
      },
      getReadCount(position) {
        return this.positionReadCount.get(position || this.position) || 0;
      },
      incrementPosition(offset) {
        if (offset < 0)
          throw new NegativeOffsetError({ offset });
        const position = this.position + offset;
        this.assertPosition(position);
        this.position = position;
      },
      inspectByte(position_) {
        const position = position_ ?? this.position;
        this.assertPosition(position);
        return this.bytes[position];
      },
      inspectBytes(length, position_) {
        const position = position_ ?? this.position;
        this.assertPosition(position + length - 1);
        return this.bytes.subarray(position, position + length);
      },
      inspectUint8(position_) {
        const position = position_ ?? this.position;
        this.assertPosition(position);
        return this.bytes[position];
      },
      inspectUint16(position_) {
        const position = position_ ?? this.position;
        this.assertPosition(position + 1);
        return this.dataView.getUint16(position);
      },
      inspectUint24(position_) {
        const position = position_ ?? this.position;
        this.assertPosition(position + 2);
        return (this.dataView.getUint16(position) << 8) + this.dataView.getUint8(position + 2);
      },
      inspectUint32(position_) {
        const position = position_ ?? this.position;
        this.assertPosition(position + 3);
        return this.dataView.getUint32(position);
      },
      pushByte(byte) {
        this.assertPosition(this.position);
        this.bytes[this.position] = byte;
        this.position++;
      },
      pushBytes(bytes) {
        this.assertPosition(this.position + bytes.length - 1);
        this.bytes.set(bytes, this.position);
        this.position += bytes.length;
      },
      pushUint8(value) {
        this.assertPosition(this.position);
        this.bytes[this.position] = value;
        this.position++;
      },
      pushUint16(value) {
        this.assertPosition(this.position + 1);
        this.dataView.setUint16(this.position, value);
        this.position += 2;
      },
      pushUint24(value) {
        this.assertPosition(this.position + 2);
        this.dataView.setUint16(this.position, value >> 8);
        this.dataView.setUint8(this.position + 2, value & ~4294967040);
        this.position += 3;
      },
      pushUint32(value) {
        this.assertPosition(this.position + 3);
        this.dataView.setUint32(this.position, value);
        this.position += 4;
      },
      readByte() {
        this.assertReadLimit();
        this._touch();
        const value = this.inspectByte();
        this.position++;
        return value;
      },
      readBytes(length, size2) {
        this.assertReadLimit();
        this._touch();
        const value = this.inspectBytes(length);
        this.position += size2 ?? length;
        return value;
      },
      readUint8() {
        this.assertReadLimit();
        this._touch();
        const value = this.inspectUint8();
        this.position += 1;
        return value;
      },
      readUint16() {
        this.assertReadLimit();
        this._touch();
        const value = this.inspectUint16();
        this.position += 2;
        return value;
      },
      readUint24() {
        this.assertReadLimit();
        this._touch();
        const value = this.inspectUint24();
        this.position += 3;
        return value;
      },
      readUint32() {
        this.assertReadLimit();
        this._touch();
        const value = this.inspectUint32();
        this.position += 4;
        return value;
      },
      get remaining() {
        return this.bytes.length - this.position;
      },
      setPosition(position) {
        const oldPosition = this.position;
        this.assertPosition(position);
        this.position = position;
        return () => this.position = oldPosition;
      },
      _touch() {
        if (this.recursiveReadLimit === Number.POSITIVE_INFINITY)
          return;
        const count = this.getReadCount();
        this.positionReadCount.set(this.position, count + 1);
        if (count > 0)
          this.recursiveReadCount++;
      }
    };
  }
});

// ../../enclave/node_modules/viem/_esm/utils/encoding/fromBytes.js
function bytesToBigInt(bytes, opts = {}) {
  if (typeof opts.size !== "undefined")
    assertSize(bytes, { size: opts.size });
  const hex = bytesToHex(bytes, opts);
  return hexToBigInt(hex, opts);
}
function bytesToBool(bytes_, opts = {}) {
  let bytes = bytes_;
  if (typeof opts.size !== "undefined") {
    assertSize(bytes, { size: opts.size });
    bytes = trim(bytes);
  }
  if (bytes.length > 1 || bytes[0] > 1)
    throw new InvalidBytesBooleanError(bytes);
  return Boolean(bytes[0]);
}
function bytesToNumber(bytes, opts = {}) {
  if (typeof opts.size !== "undefined")
    assertSize(bytes, { size: opts.size });
  const hex = bytesToHex(bytes, opts);
  return hexToNumber(hex, opts);
}
function bytesToString(bytes_, opts = {}) {
  let bytes = bytes_;
  if (typeof opts.size !== "undefined") {
    assertSize(bytes, { size: opts.size });
    bytes = trim(bytes, { dir: "right" });
  }
  return new TextDecoder().decode(bytes);
}
var init_fromBytes = __esm({
  "../../enclave/node_modules/viem/_esm/utils/encoding/fromBytes.js"() {
    init_encoding();
    init_trim();
    init_fromHex();
    init_toHex();
  }
});

// ../../enclave/node_modules/viem/_esm/utils/abi/decodeAbiParameters.js
function decodeAbiParameters(params, data) {
  const bytes = typeof data === "string" ? hexToBytes(data) : data;
  const cursor = createCursor(bytes);
  if (size(bytes) === 0 && params.length > 0)
    throw new AbiDecodingZeroDataError();
  if (size(data) && size(data) < 32)
    throw new AbiDecodingDataSizeTooSmallError({
      data: typeof data === "string" ? data : bytesToHex(data),
      params,
      size: size(data)
    });
  let consumed = 0;
  const values = [];
  for (let i = 0; i < params.length; ++i) {
    const param = params[i];
    cursor.setPosition(consumed);
    const [data2, consumed_] = decodeParameter(cursor, param, {
      staticPosition: 0
    });
    consumed += consumed_;
    values.push(data2);
  }
  return values;
}
function decodeParameter(cursor, param, { staticPosition }) {
  const arrayComponents = getArrayComponents(param.type);
  if (arrayComponents) {
    const [length, type] = arrayComponents;
    return decodeArray(cursor, { ...param, type }, { length, staticPosition });
  }
  if (param.type === "tuple")
    return decodeTuple(cursor, param, { staticPosition });
  if (param.type === "address")
    return decodeAddress(cursor);
  if (param.type === "bool")
    return decodeBool(cursor);
  if (param.type.startsWith("bytes"))
    return decodeBytes(cursor, param, { staticPosition });
  if (param.type.startsWith("uint") || param.type.startsWith("int"))
    return decodeNumber(cursor, param);
  if (param.type === "string")
    return decodeString(cursor, { staticPosition });
  throw new InvalidAbiDecodingTypeError(param.type, {
    docsPath: "/docs/contract/decodeAbiParameters"
  });
}
function decodeAddress(cursor) {
  const value = cursor.readBytes(32);
  return [checksumAddress(bytesToHex(sliceBytes(value, -20))), 32];
}
function decodeArray(cursor, param, { length, staticPosition }) {
  if (!length) {
    const offset = bytesToNumber(cursor.readBytes(sizeOfOffset));
    const start = staticPosition + offset;
    const startOfData = start + sizeOfLength;
    cursor.setPosition(start);
    const length2 = bytesToNumber(cursor.readBytes(sizeOfLength));
    const dynamicChild = hasDynamicChild(param);
    let consumed2 = 0;
    const value2 = [];
    for (let i = 0; i < length2; ++i) {
      cursor.setPosition(startOfData + (dynamicChild ? i * 32 : consumed2));
      const [data, consumed_] = decodeParameter(cursor, param, {
        staticPosition: startOfData
      });
      consumed2 += consumed_;
      value2.push(data);
    }
    cursor.setPosition(staticPosition + 32);
    return [value2, 32];
  }
  if (hasDynamicChild(param)) {
    const offset = bytesToNumber(cursor.readBytes(sizeOfOffset));
    const start = staticPosition + offset;
    const value2 = [];
    for (let i = 0; i < length; ++i) {
      cursor.setPosition(start + i * 32);
      const [data] = decodeParameter(cursor, param, {
        staticPosition: start
      });
      value2.push(data);
    }
    cursor.setPosition(staticPosition + 32);
    return [value2, 32];
  }
  let consumed = 0;
  const value = [];
  for (let i = 0; i < length; ++i) {
    const [data, consumed_] = decodeParameter(cursor, param, {
      staticPosition: staticPosition + consumed
    });
    consumed += consumed_;
    value.push(data);
  }
  return [value, consumed];
}
function decodeBool(cursor) {
  return [bytesToBool(cursor.readBytes(32), { size: 32 }), 32];
}
function decodeBytes(cursor, param, { staticPosition }) {
  const [_, size2] = param.type.split("bytes");
  if (!size2) {
    const offset = bytesToNumber(cursor.readBytes(32));
    cursor.setPosition(staticPosition + offset);
    const length = bytesToNumber(cursor.readBytes(32));
    if (length === 0) {
      cursor.setPosition(staticPosition + 32);
      return ["0x", 32];
    }
    const data = cursor.readBytes(length);
    cursor.setPosition(staticPosition + 32);
    return [bytesToHex(data), 32];
  }
  const value = bytesToHex(cursor.readBytes(Number.parseInt(size2, 10), 32));
  return [value, 32];
}
function decodeNumber(cursor, param) {
  const signed = param.type.startsWith("int");
  const size2 = Number.parseInt(param.type.split("int")[1] || "256", 10);
  const value = cursor.readBytes(32);
  return [
    size2 > 48 ? bytesToBigInt(value, { signed }) : bytesToNumber(value, { signed }),
    32
  ];
}
function decodeTuple(cursor, param, { staticPosition }) {
  const hasUnnamedChild = param.components.length === 0 || param.components.some(({ name }) => !name);
  const value = hasUnnamedChild ? [] : {};
  let consumed = 0;
  if (hasDynamicChild(param)) {
    const offset = bytesToNumber(cursor.readBytes(sizeOfOffset));
    const start = staticPosition + offset;
    for (let i = 0; i < param.components.length; ++i) {
      const component = param.components[i];
      cursor.setPosition(start + consumed);
      const [data, consumed_] = decodeParameter(cursor, component, {
        staticPosition: start
      });
      consumed += consumed_;
      value[hasUnnamedChild ? i : component?.name] = data;
    }
    cursor.setPosition(staticPosition + 32);
    return [value, 32];
  }
  for (let i = 0; i < param.components.length; ++i) {
    const component = param.components[i];
    const [data, consumed_] = decodeParameter(cursor, component, {
      staticPosition
    });
    value[hasUnnamedChild ? i : component?.name] = data;
    consumed += consumed_;
  }
  return [value, consumed];
}
function decodeString(cursor, { staticPosition }) {
  const offset = bytesToNumber(cursor.readBytes(32));
  const start = staticPosition + offset;
  cursor.setPosition(start);
  const length = bytesToNumber(cursor.readBytes(32));
  if (length === 0) {
    cursor.setPosition(staticPosition + 32);
    return ["", 32];
  }
  const data = cursor.readBytes(length, 32);
  const value = bytesToString(trim(data));
  cursor.setPosition(staticPosition + 32);
  return [value, 32];
}
function hasDynamicChild(param) {
  const { type } = param;
  if (type === "string")
    return true;
  if (type === "bytes")
    return true;
  if (type.endsWith("[]"))
    return true;
  if (type === "tuple")
    return param.components?.some(hasDynamicChild);
  const arrayComponents = getArrayComponents(param.type);
  if (arrayComponents && hasDynamicChild({ ...param, type: arrayComponents[1] }))
    return true;
  return false;
}
var sizeOfLength, sizeOfOffset;
var init_decodeAbiParameters = __esm({
  "../../enclave/node_modules/viem/_esm/utils/abi/decodeAbiParameters.js"() {
    init_abi();
    init_getAddress();
    init_cursor2();
    init_size();
    init_slice();
    init_trim();
    init_fromBytes();
    init_toBytes();
    init_toHex();
    init_encodeAbiParameters();
    sizeOfLength = 32;
    sizeOfOffset = 32;
  }
});

// ../../enclave/node_modules/viem/_esm/utils/stringify.js
var stringify;
var init_stringify = __esm({
  "../../enclave/node_modules/viem/_esm/utils/stringify.js"() {
    stringify = (value, replacer, space) => JSON.stringify(value, (key, value_) => {
      const value2 = typeof value_ === "bigint" ? value_.toString() : value_;
      return typeof replacer === "function" ? replacer(key, value2) : value2;
    }, space);
  }
});

// ../../enclave/node_modules/@noble/hashes/esm/_md.js
function setBigUint64(view, byteOffset, value, isLE2) {
  if (typeof view.setBigUint64 === "function")
    return view.setBigUint64(byteOffset, value, isLE2);
  const _32n2 = BigInt(32);
  const _u32_max = BigInt(4294967295);
  const wh = Number(value >> _32n2 & _u32_max);
  const wl = Number(value & _u32_max);
  const h = isLE2 ? 4 : 0;
  const l = isLE2 ? 0 : 4;
  view.setUint32(byteOffset + h, wh, isLE2);
  view.setUint32(byteOffset + l, wl, isLE2);
}
function Chi(a, b, c) {
  return a & b ^ ~a & c;
}
function Maj(a, b, c) {
  return a & b ^ a & c ^ b & c;
}
var HashMD, SHA256_IV;
var init_md = __esm({
  "../../enclave/node_modules/@noble/hashes/esm/_md.js"() {
    init_utils2();
    HashMD = class extends Hash {
      constructor(blockLen, outputLen, padOffset, isLE2) {
        super();
        this.finished = false;
        this.length = 0;
        this.pos = 0;
        this.destroyed = false;
        this.blockLen = blockLen;
        this.outputLen = outputLen;
        this.padOffset = padOffset;
        this.isLE = isLE2;
        this.buffer = new Uint8Array(blockLen);
        this.view = createView(this.buffer);
      }
      update(data) {
        aexists(this);
        data = toBytes2(data);
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
        const { buffer, view, blockLen, isLE: isLE2 } = this;
        let { pos } = this;
        buffer[pos++] = 128;
        clean(this.buffer.subarray(pos));
        if (this.padOffset > blockLen - pos) {
          this.process(view, 0);
          pos = 0;
        }
        for (let i = pos; i < blockLen; i++)
          buffer[i] = 0;
        setBigUint64(view, blockLen - 8, BigInt(this.length * 8), isLE2);
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
          oview.setUint32(4 * i, state[i], isLE2);
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
  }
});

// ../../enclave/node_modules/@noble/hashes/esm/sha2.js
var SHA256_K, SHA256_W, SHA256, sha256;
var init_sha2 = __esm({
  "../../enclave/node_modules/@noble/hashes/esm/sha2.js"() {
    init_md();
    init_utils2();
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
    sha256 = /* @__PURE__ */ createHasher(() => new SHA256());
  }
});

// ../../enclave/node_modules/@noble/hashes/esm/hmac.js
var HMAC, hmac;
var init_hmac = __esm({
  "../../enclave/node_modules/@noble/hashes/esm/hmac.js"() {
    init_utils2();
    HMAC = class extends Hash {
      constructor(hash2, _key) {
        super();
        this.finished = false;
        this.destroyed = false;
        ahash(hash2);
        const key = toBytes2(_key);
        this.iHash = hash2.create();
        if (typeof this.iHash.update !== "function")
          throw new Error("Expected instance of class which extends utils.Hash");
        this.blockLen = this.iHash.blockLen;
        this.outputLen = this.iHash.outputLen;
        const blockLen = this.blockLen;
        const pad2 = new Uint8Array(blockLen);
        pad2.set(key.length > blockLen ? hash2.create().update(key).digest() : key);
        for (let i = 0; i < pad2.length; i++)
          pad2[i] ^= 54;
        this.iHash.update(pad2);
        this.oHash = hash2.create();
        for (let i = 0; i < pad2.length; i++)
          pad2[i] ^= 54 ^ 92;
        this.oHash.update(pad2);
        clean(pad2);
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
    hmac = (hash2, key, message) => new HMAC(hash2, key).update(message).digest();
    hmac.create = (hash2, key) => new HMAC(hash2, key);
  }
});

// ../../enclave/node_modules/@noble/curves/esm/abstract/utils.js
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
function numberToHexUnpadded(num2) {
  const hex = num2.toString(16);
  return hex.length & 1 ? "0" + hex : hex;
}
function hexToNumber2(hex) {
  if (typeof hex !== "string")
    throw new Error("hex string expected, got " + typeof hex);
  return hex === "" ? _0n2 : BigInt("0x" + hex);
}
function bytesToHex2(bytes) {
  abytes2(bytes);
  if (hasHexBuiltin)
    return bytes.toHex();
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += hexes2[bytes[i]];
  }
  return hex;
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
function hexToBytes2(hex) {
  if (typeof hex !== "string")
    throw new Error("hex string expected, got " + typeof hex);
  if (hasHexBuiltin)
    return Uint8Array.fromHex(hex);
  const hl = hex.length;
  const al = hl / 2;
  if (hl % 2)
    throw new Error("hex string expected, got unpadded hex of length " + hl);
  const array = new Uint8Array(al);
  for (let ai = 0, hi = 0; ai < al; ai++, hi += 2) {
    const n1 = asciiToBase16(hex.charCodeAt(hi));
    const n2 = asciiToBase16(hex.charCodeAt(hi + 1));
    if (n1 === void 0 || n2 === void 0) {
      const char = hex[hi] + hex[hi + 1];
      throw new Error('hex string expected, got non-hex character "' + char + '" at index ' + hi);
    }
    array[ai] = n1 * 16 + n2;
  }
  return array;
}
function bytesToNumberBE(bytes) {
  return hexToNumber2(bytesToHex2(bytes));
}
function bytesToNumberLE(bytes) {
  abytes2(bytes);
  return hexToNumber2(bytesToHex2(Uint8Array.from(bytes).reverse()));
}
function numberToBytesBE(n, len) {
  return hexToBytes2(n.toString(16).padStart(len * 2, "0"));
}
function numberToBytesLE(n, len) {
  return numberToBytesBE(n, len).reverse();
}
function ensureBytes(title, hex, expectedLength) {
  let res;
  if (typeof hex === "string") {
    try {
      res = hexToBytes2(hex);
    } catch (e) {
      throw new Error(title + " must be hex string or Uint8Array, cause: " + e);
    }
  } else if (isBytes2(hex)) {
    res = Uint8Array.from(hex);
  } else {
    throw new Error(title + " must be hex string or Uint8Array");
  }
  const len = res.length;
  if (typeof expectedLength === "number" && len !== expectedLength)
    throw new Error(title + " of length " + expectedLength + " expected, got " + len);
  return res;
}
function concatBytes3(...arrays) {
  let sum = 0;
  for (let i = 0; i < arrays.length; i++) {
    const a = arrays[i];
    abytes2(a);
    sum += a.length;
  }
  const res = new Uint8Array(sum);
  for (let i = 0, pad2 = 0; i < arrays.length; i++) {
    const a = arrays[i];
    res.set(a, pad2);
    pad2 += a.length;
  }
  return res;
}
function utf8ToBytes2(str2) {
  if (typeof str2 !== "string")
    throw new Error("string expected");
  return new Uint8Array(new TextEncoder().encode(str2));
}
function inRange(n, min, max2) {
  return isPosBig(n) && isPosBig(min) && isPosBig(max2) && min <= n && n < max2;
}
function aInRange(title, n, min, max2) {
  if (!inRange(n, min, max2))
    throw new Error("expected valid " + title + ": " + min + " <= n < " + max2 + ", got " + n);
}
function bitLen(n) {
  let len;
  for (len = 0; n > _0n2; n >>= _1n2, len += 1)
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
  const gen2 = () => {
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
    return concatBytes3(...out);
  };
  const genUntil = (seed, pred) => {
    reset();
    reseed(seed);
    let res = void 0;
    while (!(res = pred(gen2())))
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
var _0n2, _1n2, hasHexBuiltin, hexes2, asciis, isPosBig, bitMask, u8n, u8fr, validatorFns;
var init_utils3 = __esm({
  "../../enclave/node_modules/@noble/curves/esm/abstract/utils.js"() {
    _0n2 = /* @__PURE__ */ BigInt(0);
    _1n2 = /* @__PURE__ */ BigInt(1);
    hasHexBuiltin = // @ts-ignore
    typeof Uint8Array.from([]).toHex === "function" && typeof Uint8Array.fromHex === "function";
    hexes2 = /* @__PURE__ */ Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
    asciis = { _0: 48, _9: 57, A: 65, F: 70, a: 97, f: 102 };
    isPosBig = (n) => typeof n === "bigint" && _0n2 <= n;
    bitMask = (n) => (_1n2 << BigInt(n)) - _1n2;
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

// ../../enclave/node_modules/@noble/curves/esm/abstract/modular.js
function mod(a, b) {
  const result = a % b;
  return result >= _0n3 ? result : b + result;
}
function pow2(x, power, modulo) {
  let res = x;
  while (power-- > _0n3) {
    res *= res;
    res %= modulo;
  }
  return res;
}
function invert(number, modulo) {
  if (number === _0n3)
    throw new Error("invert: expected non-zero number");
  if (modulo <= _0n3)
    throw new Error("invert: expected positive modulus, got " + modulo);
  let a = mod(number, modulo);
  let b = modulo;
  let x = _0n3, y = _1n3, u = _1n3, v = _0n3;
  while (a !== _0n3) {
    const q = b / a;
    const r = b % a;
    const m = x - u * q;
    const n = y - v * q;
    b = a, a = r, x = u, y = v, u = m, v = n;
  }
  const gcd = b;
  if (gcd !== _1n3)
    throw new Error("invert: does not exist");
  return mod(x, modulo);
}
function sqrt3mod4(Fp, n) {
  const p1div4 = (Fp.ORDER + _1n3) / _4n;
  const root = Fp.pow(n, p1div4);
  if (!Fp.eql(Fp.sqr(root), n))
    throw new Error("Cannot find square root");
  return root;
}
function sqrt5mod8(Fp, n) {
  const p5div8 = (Fp.ORDER - _5n) / _8n;
  const n2 = Fp.mul(n, _2n2);
  const v = Fp.pow(n2, p5div8);
  const nv = Fp.mul(n, v);
  const i = Fp.mul(Fp.mul(nv, _2n2), v);
  const root = Fp.mul(nv, Fp.sub(i, Fp.ONE));
  if (!Fp.eql(Fp.sqr(root), n))
    throw new Error("Cannot find square root");
  return root;
}
function tonelliShanks(P) {
  if (P < BigInt(3))
    throw new Error("sqrt is not defined for small field");
  let Q = P - _1n3;
  let S = 0;
  while (Q % _2n2 === _0n3) {
    Q /= _2n2;
    S++;
  }
  let Z = _2n2;
  const _Fp = Field(P);
  while (FpLegendre(_Fp, Z) === 1) {
    if (Z++ > 1e3)
      throw new Error("Cannot find square root: probably non-prime P");
  }
  if (S === 1)
    return sqrt3mod4;
  let cc = _Fp.pow(Z, Q);
  const Q1div2 = (Q + _1n3) / _2n2;
  return function tonelliSlow(Fp, n) {
    if (Fp.is0(n))
      return n;
    if (FpLegendre(Fp, n) !== 1)
      throw new Error("Cannot find square root");
    let M = S;
    let c = Fp.mul(Fp.ONE, cc);
    let t = Fp.pow(n, Q);
    let R = Fp.pow(n, Q1div2);
    while (!Fp.eql(t, Fp.ONE)) {
      if (Fp.is0(t))
        return Fp.ZERO;
      let i = 1;
      let t_tmp = Fp.sqr(t);
      while (!Fp.eql(t_tmp, Fp.ONE)) {
        i++;
        t_tmp = Fp.sqr(t_tmp);
        if (i === M)
          throw new Error("Cannot find square root");
      }
      const exponent = _1n3 << BigInt(M - i - 1);
      const b = Fp.pow(c, exponent);
      M = i;
      c = Fp.sqr(b);
      t = Fp.mul(t, c);
      R = Fp.mul(R, b);
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
function FpPow(Fp, num2, power) {
  if (power < _0n3)
    throw new Error("invalid exponent, negatives unsupported");
  if (power === _0n3)
    return Fp.ONE;
  if (power === _1n3)
    return num2;
  let p = Fp.ONE;
  let d = num2;
  while (power > _0n3) {
    if (power & _1n3)
      p = Fp.mul(p, d);
    d = Fp.sqr(d);
    power >>= _1n3;
  }
  return p;
}
function FpInvertBatch(Fp, nums, passZero = false) {
  const inverted = new Array(nums.length).fill(passZero ? Fp.ZERO : void 0);
  const multipliedAcc = nums.reduce((acc, num2, i) => {
    if (Fp.is0(num2))
      return acc;
    inverted[i] = acc;
    return Fp.mul(acc, num2);
  }, Fp.ONE);
  const invertedAcc = Fp.inv(multipliedAcc);
  nums.reduceRight((acc, num2, i) => {
    if (Fp.is0(num2))
      return acc;
    inverted[i] = Fp.mul(acc, inverted[i]);
    return Fp.mul(acc, num2);
  }, invertedAcc);
  return inverted;
}
function FpLegendre(Fp, n) {
  const p1mod2 = (Fp.ORDER - _1n3) / _2n2;
  const powered = Fp.pow(n, p1mod2);
  const yes = Fp.eql(powered, Fp.ONE);
  const zero = Fp.eql(powered, Fp.ZERO);
  const no = Fp.eql(powered, Fp.neg(Fp.ONE));
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
function Field(ORDER2, bitLen2, isLE2 = false, redef = {}) {
  if (ORDER2 <= _0n3)
    throw new Error("invalid field: expected ORDER > 0, got " + ORDER2);
  const { nBitLength: BITS, nByteLength: BYTES } = nLength(ORDER2, bitLen2);
  if (BYTES > 2048)
    throw new Error("invalid field: expected ORDER of <= 2048 bytes");
  let sqrtP;
  const f = Object.freeze({
    ORDER: ORDER2,
    isLE: isLE2,
    BITS,
    BYTES,
    MASK: bitMask(BITS),
    ZERO: _0n3,
    ONE: _1n3,
    create: (num2) => mod(num2, ORDER2),
    isValid: (num2) => {
      if (typeof num2 !== "bigint")
        throw new Error("invalid field element: expected bigint, got " + typeof num2);
      return _0n3 <= num2 && num2 < ORDER2;
    },
    is0: (num2) => num2 === _0n3,
    isOdd: (num2) => (num2 & _1n3) === _1n3,
    neg: (num2) => mod(-num2, ORDER2),
    eql: (lhs, rhs) => lhs === rhs,
    sqr: (num2) => mod(num2 * num2, ORDER2),
    add: (lhs, rhs) => mod(lhs + rhs, ORDER2),
    sub: (lhs, rhs) => mod(lhs - rhs, ORDER2),
    mul: (lhs, rhs) => mod(lhs * rhs, ORDER2),
    pow: (num2, power) => FpPow(f, num2, power),
    div: (lhs, rhs) => mod(lhs * invert(rhs, ORDER2), ORDER2),
    // Same as above, but doesn't normalize
    sqrN: (num2) => num2 * num2,
    addN: (lhs, rhs) => lhs + rhs,
    subN: (lhs, rhs) => lhs - rhs,
    mulN: (lhs, rhs) => lhs * rhs,
    inv: (num2) => invert(num2, ORDER2),
    sqrt: redef.sqrt || ((n) => {
      if (!sqrtP)
        sqrtP = FpSqrt(ORDER2);
      return sqrtP(f, n);
    }),
    toBytes: (num2) => isLE2 ? numberToBytesLE(num2, BYTES) : numberToBytesBE(num2, BYTES),
    fromBytes: (bytes) => {
      if (bytes.length !== BYTES)
        throw new Error("Field.fromBytes: expected " + BYTES + " bytes, got " + bytes.length);
      return isLE2 ? bytesToNumberLE(bytes) : bytesToNumberBE(bytes);
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
  const bitLength = fieldOrder.toString(2).length;
  return Math.ceil(bitLength / 8);
}
function getMinHashLength(fieldOrder) {
  const length = getFieldBytesLength(fieldOrder);
  return length + Math.ceil(length / 2);
}
function mapHashToField(key, fieldOrder, isLE2 = false) {
  const len = key.length;
  const fieldLen = getFieldBytesLength(fieldOrder);
  const minLen = getMinHashLength(fieldOrder);
  if (len < 16 || len < minLen || len > 1024)
    throw new Error("expected " + minLen + "-1024 bytes of input, got " + len);
  const num2 = isLE2 ? bytesToNumberLE(key) : bytesToNumberBE(key);
  const reduced = mod(num2, fieldOrder - _1n3) + _1n3;
  return isLE2 ? numberToBytesLE(reduced, fieldLen) : numberToBytesBE(reduced, fieldLen);
}
var _0n3, _1n3, _2n2, _3n, _4n, _5n, _8n, FIELD_FIELDS;
var init_modular = __esm({
  "../../enclave/node_modules/@noble/curves/esm/abstract/modular.js"() {
    init_utils2();
    init_utils3();
    _0n3 = BigInt(0);
    _1n3 = BigInt(1);
    _2n2 = /* @__PURE__ */ BigInt(2);
    _3n = /* @__PURE__ */ BigInt(3);
    _4n = /* @__PURE__ */ BigInt(4);
    _5n = /* @__PURE__ */ BigInt(5);
    _8n = /* @__PURE__ */ BigInt(8);
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

// ../../enclave/node_modules/@noble/curves/esm/abstract/curve.js
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
    nextN += _1n4;
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
      while (n > _0n4) {
        if (n & _1n4)
          p = p.add(d);
        d = d.double();
        n >>= _1n4;
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
        if (n === _0n4)
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
var _0n4, _1n4, pointPrecomputes, pointWindowSizes;
var init_curve = __esm({
  "../../enclave/node_modules/@noble/curves/esm/abstract/curve.js"() {
    init_modular();
    init_utils3();
    _0n4 = BigInt(0);
    _1n4 = BigInt(1);
    pointPrecomputes = /* @__PURE__ */ new WeakMap();
    pointWindowSizes = /* @__PURE__ */ new WeakMap();
  }
});

// ../../enclave/node_modules/@noble/curves/esm/abstract/weierstrass.js
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
  const { endo, Fp, a } = opts;
  if (endo) {
    if (!Fp.eql(a, Fp.ZERO)) {
      throw new Error("invalid endo: CURVE.a must be 0");
    }
    if (typeof endo !== "object" || typeof endo.beta !== "bigint" || typeof endo.splitScalar !== "function") {
      throw new Error('invalid endo: expected "beta": bigint and "splitScalar": function');
    }
  }
  return Object.freeze({ ...opts });
}
function numToSizedHex(num2, size2) {
  return bytesToHex2(numberToBytesBE(num2, size2));
}
function weierstrassPoints(opts) {
  const CURVE = validatePointOpts(opts);
  const { Fp } = CURVE;
  const Fn = Field(CURVE.n, CURVE.nBitLength);
  const toBytes3 = CURVE.toBytes || ((_c, point, _isCompressed) => {
    const a = point.toAffine();
    return concatBytes3(Uint8Array.from([4]), Fp.toBytes(a.x), Fp.toBytes(a.y));
  });
  const fromBytes = CURVE.fromBytes || ((bytes) => {
    const tail = bytes.subarray(1);
    const x = Fp.fromBytes(tail.subarray(0, Fp.BYTES));
    const y = Fp.fromBytes(tail.subarray(Fp.BYTES, 2 * Fp.BYTES));
    return { x, y };
  });
  function weierstrassEquation(x) {
    const { a, b } = CURVE;
    const x2 = Fp.sqr(x);
    const x3 = Fp.mul(x2, x);
    return Fp.add(Fp.add(x3, Fp.mul(x, a)), b);
  }
  function isValidXY(x, y) {
    const left = Fp.sqr(y);
    const right = weierstrassEquation(x);
    return Fp.eql(left, right);
  }
  if (!isValidXY(CURVE.Gx, CURVE.Gy))
    throw new Error("bad curve params: generator point");
  const _4a3 = Fp.mul(Fp.pow(CURVE.a, _3n2), _4n2);
  const _27b2 = Fp.mul(Fp.sqr(CURVE.b), BigInt(27));
  if (Fp.is0(Fp.add(_4a3, _27b2)))
    throw new Error("bad curve params: a or b");
  function isWithinCurveOrder(num2) {
    return inRange(num2, _1n5, CURVE.n);
  }
  function normPrivateKeyToScalar(key) {
    const { allowedPrivateKeyLengths: lengths, nByteLength, wrapPrivateKey, n: N } = CURVE;
    if (lengths && typeof key !== "bigint") {
      if (isBytes2(key))
        key = bytesToHex2(key);
      if (typeof key !== "string" || !lengths.includes(key.length))
        throw new Error("invalid private key");
      key = key.padStart(nByteLength * 2, "0");
    }
    let num2;
    try {
      num2 = typeof key === "bigint" ? key : bytesToNumberBE(ensureBytes("private key", key, nByteLength));
    } catch (error) {
      throw new Error("invalid private key, expected hex or " + nByteLength + " bytes, got " + typeof key);
    }
    if (wrapPrivateKey)
      num2 = mod(num2, N);
    aInRange("private key", num2, _1n5, N);
    return num2;
  }
  function aprjpoint(other) {
    if (!(other instanceof Point2))
      throw new Error("ProjectivePoint expected");
  }
  const toAffineMemo = memoized((p, iz) => {
    const { px: x, py: y, pz: z } = p;
    if (Fp.eql(z, Fp.ONE))
      return { x, y };
    const is0 = p.is0();
    if (iz == null)
      iz = is0 ? Fp.ONE : Fp.inv(z);
    const ax = Fp.mul(x, iz);
    const ay = Fp.mul(y, iz);
    const zz = Fp.mul(z, iz);
    if (is0)
      return { x: Fp.ZERO, y: Fp.ZERO };
    if (!Fp.eql(zz, Fp.ONE))
      throw new Error("invZ was invalid");
    return { x: ax, y: ay };
  });
  const assertValidMemo = memoized((p) => {
    if (p.is0()) {
      if (CURVE.allowInfinityPoint && !Fp.is0(p.py))
        return;
      throw new Error("bad point: ZERO");
    }
    const { x, y } = p.toAffine();
    if (!Fp.isValid(x) || !Fp.isValid(y))
      throw new Error("bad point: x or y not FE");
    if (!isValidXY(x, y))
      throw new Error("bad point: equation left != right");
    if (!p.isTorsionFree())
      throw new Error("bad point: not in prime-order subgroup");
    return true;
  });
  class Point2 {
    constructor(px, py, pz) {
      if (px == null || !Fp.isValid(px))
        throw new Error("x required");
      if (py == null || !Fp.isValid(py) || Fp.is0(py))
        throw new Error("y required");
      if (pz == null || !Fp.isValid(pz))
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
      if (!p || !Fp.isValid(x) || !Fp.isValid(y))
        throw new Error("invalid affine point");
      if (p instanceof Point2)
        throw new Error("projective point not allowed");
      const is0 = (i) => Fp.eql(i, Fp.ZERO);
      if (is0(x) && is0(y))
        return Point2.ZERO;
      return new Point2(x, y, Fp.ONE);
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
      const toInv = FpInvertBatch(Fp, points.map((p) => p.pz));
      return points.map((p, i) => p.toAffine(toInv[i])).map(Point2.fromAffine);
    }
    /**
     * Converts hash string or Uint8Array to Point.
     * @param hex short/long ECDSA hex
     */
    static fromHex(hex) {
      const P = Point2.fromAffine(fromBytes(ensureBytes("pointHex", hex)));
      P.assertValidity();
      return P;
    }
    // Multiplies generator point by privateKey.
    static fromPrivateKey(privateKey) {
      return Point2.BASE.multiply(normPrivateKeyToScalar(privateKey));
    }
    // Multiscalar Multiplication
    static msm(points, scalars) {
      return pippenger(Point2, Fn, points, scalars);
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
      if (Fp.isOdd)
        return !Fp.isOdd(y);
      throw new Error("Field doesn't support isOdd");
    }
    /**
     * Compare one point to another.
     */
    equals(other) {
      aprjpoint(other);
      const { px: X1, py: Y1, pz: Z1 } = this;
      const { px: X2, py: Y2, pz: Z2 } = other;
      const U1 = Fp.eql(Fp.mul(X1, Z2), Fp.mul(X2, Z1));
      const U2 = Fp.eql(Fp.mul(Y1, Z2), Fp.mul(Y2, Z1));
      return U1 && U2;
    }
    /**
     * Flips point to one corresponding to (x, -y) in Affine coordinates.
     */
    negate() {
      return new Point2(this.px, Fp.neg(this.py), this.pz);
    }
    // Renes-Costello-Batina exception-free doubling formula.
    // There is 30% faster Jacobian formula, but it is not complete.
    // https://eprint.iacr.org/2015/1060, algorithm 3
    // Cost: 8M + 3S + 3*a + 2*b3 + 15add.
    double() {
      const { a, b } = CURVE;
      const b3 = Fp.mul(b, _3n2);
      const { px: X1, py: Y1, pz: Z1 } = this;
      let X3 = Fp.ZERO, Y3 = Fp.ZERO, Z3 = Fp.ZERO;
      let t0 = Fp.mul(X1, X1);
      let t1 = Fp.mul(Y1, Y1);
      let t2 = Fp.mul(Z1, Z1);
      let t3 = Fp.mul(X1, Y1);
      t3 = Fp.add(t3, t3);
      Z3 = Fp.mul(X1, Z1);
      Z3 = Fp.add(Z3, Z3);
      X3 = Fp.mul(a, Z3);
      Y3 = Fp.mul(b3, t2);
      Y3 = Fp.add(X3, Y3);
      X3 = Fp.sub(t1, Y3);
      Y3 = Fp.add(t1, Y3);
      Y3 = Fp.mul(X3, Y3);
      X3 = Fp.mul(t3, X3);
      Z3 = Fp.mul(b3, Z3);
      t2 = Fp.mul(a, t2);
      t3 = Fp.sub(t0, t2);
      t3 = Fp.mul(a, t3);
      t3 = Fp.add(t3, Z3);
      Z3 = Fp.add(t0, t0);
      t0 = Fp.add(Z3, t0);
      t0 = Fp.add(t0, t2);
      t0 = Fp.mul(t0, t3);
      Y3 = Fp.add(Y3, t0);
      t2 = Fp.mul(Y1, Z1);
      t2 = Fp.add(t2, t2);
      t0 = Fp.mul(t2, t3);
      X3 = Fp.sub(X3, t0);
      Z3 = Fp.mul(t2, t1);
      Z3 = Fp.add(Z3, Z3);
      Z3 = Fp.add(Z3, Z3);
      return new Point2(X3, Y3, Z3);
    }
    // Renes-Costello-Batina exception-free addition formula.
    // There is 30% faster Jacobian formula, but it is not complete.
    // https://eprint.iacr.org/2015/1060, algorithm 1
    // Cost: 12M + 0S + 3*a + 3*b3 + 23add.
    add(other) {
      aprjpoint(other);
      const { px: X1, py: Y1, pz: Z1 } = this;
      const { px: X2, py: Y2, pz: Z2 } = other;
      let X3 = Fp.ZERO, Y3 = Fp.ZERO, Z3 = Fp.ZERO;
      const a = CURVE.a;
      const b3 = Fp.mul(CURVE.b, _3n2);
      let t0 = Fp.mul(X1, X2);
      let t1 = Fp.mul(Y1, Y2);
      let t2 = Fp.mul(Z1, Z2);
      let t3 = Fp.add(X1, Y1);
      let t4 = Fp.add(X2, Y2);
      t3 = Fp.mul(t3, t4);
      t4 = Fp.add(t0, t1);
      t3 = Fp.sub(t3, t4);
      t4 = Fp.add(X1, Z1);
      let t5 = Fp.add(X2, Z2);
      t4 = Fp.mul(t4, t5);
      t5 = Fp.add(t0, t2);
      t4 = Fp.sub(t4, t5);
      t5 = Fp.add(Y1, Z1);
      X3 = Fp.add(Y2, Z2);
      t5 = Fp.mul(t5, X3);
      X3 = Fp.add(t1, t2);
      t5 = Fp.sub(t5, X3);
      Z3 = Fp.mul(a, t4);
      X3 = Fp.mul(b3, t2);
      Z3 = Fp.add(X3, Z3);
      X3 = Fp.sub(t1, Z3);
      Z3 = Fp.add(t1, Z3);
      Y3 = Fp.mul(X3, Z3);
      t1 = Fp.add(t0, t0);
      t1 = Fp.add(t1, t0);
      t2 = Fp.mul(a, t2);
      t4 = Fp.mul(b3, t4);
      t1 = Fp.add(t1, t2);
      t2 = Fp.sub(t0, t2);
      t2 = Fp.mul(a, t2);
      t4 = Fp.add(t4, t2);
      t0 = Fp.mul(t1, t4);
      Y3 = Fp.add(Y3, t0);
      t0 = Fp.mul(t5, t4);
      X3 = Fp.mul(t3, X3);
      X3 = Fp.sub(X3, t0);
      t0 = Fp.mul(t3, t1);
      Z3 = Fp.mul(t5, Z3);
      Z3 = Fp.add(Z3, t0);
      return new Point2(X3, Y3, Z3);
    }
    subtract(other) {
      return this.add(other.negate());
    }
    is0() {
      return this.equals(Point2.ZERO);
    }
    wNAF(n) {
      return wnaf.wNAFCached(this, n, Point2.normalizeZ);
    }
    /**
     * Non-constant-time multiplication. Uses double-and-add algorithm.
     * It's faster, but should only be used when you don't care about
     * an exposed private key e.g. sig verification, which works over *public* keys.
     */
    multiplyUnsafe(sc) {
      const { endo: endo2, n: N } = CURVE;
      aInRange("scalar", sc, _0n5, N);
      const I = Point2.ZERO;
      if (sc === _0n5)
        return I;
      if (this.is0() || sc === _1n5)
        return this;
      if (!endo2 || wnaf.hasPrecomputes(this))
        return wnaf.wNAFCachedUnsafe(this, sc, Point2.normalizeZ);
      let { k1neg, k1, k2neg, k2 } = endo2.splitScalar(sc);
      let k1p = I;
      let k2p = I;
      let d = this;
      while (k1 > _0n5 || k2 > _0n5) {
        if (k1 & _1n5)
          k1p = k1p.add(d);
        if (k2 & _1n5)
          k2p = k2p.add(d);
        d = d.double();
        k1 >>= _1n5;
        k2 >>= _1n5;
      }
      if (k1neg)
        k1p = k1p.negate();
      if (k2neg)
        k2p = k2p.negate();
      k2p = new Point2(Fp.mul(k2p.px, endo2.beta), k2p.py, k2p.pz);
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
      aInRange("scalar", scalar, _1n5, N);
      let point, fake;
      if (endo2) {
        const { k1neg, k1, k2neg, k2 } = endo2.splitScalar(scalar);
        let { p: k1p, f: f1p } = this.wNAF(k1);
        let { p: k2p, f: f2p } = this.wNAF(k2);
        k1p = wnaf.constTimeNegate(k1neg, k1p);
        k2p = wnaf.constTimeNegate(k2neg, k2p);
        k2p = new Point2(Fp.mul(k2p.px, endo2.beta), k2p.py, k2p.pz);
        point = k1p.add(k2p);
        fake = f1p.add(f2p);
      } else {
        const { p, f } = this.wNAF(scalar);
        point = p;
        fake = f;
      }
      return Point2.normalizeZ([point, fake])[0];
    }
    /**
     * Efficiently calculate `aP + bQ`. Unsafe, can expose private key, if used incorrectly.
     * Not using Strauss-Shamir trick: precomputation tables are faster.
     * The trick could be useful if both P and Q are not G (not in our case).
     * @returns non-zero affine point
     */
    multiplyAndAddUnsafe(Q, a, b) {
      const G = Point2.BASE;
      const mul = (P, a2) => a2 === _0n5 || a2 === _1n5 || !P.equals(G) ? P.multiplyUnsafe(a2) : P.multiply(a2);
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
      if (cofactor === _1n5)
        return true;
      if (isTorsionFree)
        return isTorsionFree(Point2, this);
      throw new Error("isTorsionFree() has not been declared for the elliptic curve");
    }
    clearCofactor() {
      const { h: cofactor, clearCofactor } = CURVE;
      if (cofactor === _1n5)
        return this;
      if (clearCofactor)
        return clearCofactor(Point2, this);
      return this.multiplyUnsafe(CURVE.h);
    }
    toRawBytes(isCompressed = true) {
      abool("isCompressed", isCompressed);
      this.assertValidity();
      return toBytes3(Point2, this, isCompressed);
    }
    toHex(isCompressed = true) {
      abool("isCompressed", isCompressed);
      return bytesToHex2(this.toRawBytes(isCompressed));
    }
  }
  Point2.BASE = new Point2(CURVE.Gx, CURVE.Gy, Fp.ONE);
  Point2.ZERO = new Point2(Fp.ZERO, Fp.ONE, Fp.ZERO);
  const { endo, nBitLength } = CURVE;
  const wnaf = wNAF(Point2, endo ? Math.ceil(nBitLength / 2) : nBitLength);
  return {
    CURVE,
    ProjectivePoint: Point2,
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
  const { Fp, n: CURVE_ORDER, nByteLength, nBitLength } = CURVE;
  const compressedLen = Fp.BYTES + 1;
  const uncompressedLen = 2 * Fp.BYTES + 1;
  function modN2(a) {
    return mod(a, CURVE_ORDER);
  }
  function invN(a) {
    return invert(a, CURVE_ORDER);
  }
  const { ProjectivePoint: Point2, normPrivateKeyToScalar, weierstrassEquation, isWithinCurveOrder } = weierstrassPoints({
    ...CURVE,
    toBytes(_c, point, isCompressed) {
      const a = point.toAffine();
      const x = Fp.toBytes(a.x);
      const cat = concatBytes3;
      abool("isCompressed", isCompressed);
      if (isCompressed) {
        return cat(Uint8Array.from([point.hasEvenY() ? 2 : 3]), x);
      } else {
        return cat(Uint8Array.from([4]), x, Fp.toBytes(a.y));
      }
    },
    fromBytes(bytes) {
      const len = bytes.length;
      const head = bytes[0];
      const tail = bytes.subarray(1);
      if (len === compressedLen && (head === 2 || head === 3)) {
        const x = bytesToNumberBE(tail);
        if (!inRange(x, _1n5, Fp.ORDER))
          throw new Error("Point is not on curve");
        const y2 = weierstrassEquation(x);
        let y;
        try {
          y = Fp.sqrt(y2);
        } catch (sqrtError) {
          const suffix = sqrtError instanceof Error ? ": " + sqrtError.message : "";
          throw new Error("Point is not on curve" + suffix);
        }
        const isYOdd = (y & _1n5) === _1n5;
        const isHeadOdd = (head & 1) === 1;
        if (isHeadOdd !== isYOdd)
          y = Fp.neg(y);
        return { x, y };
      } else if (len === uncompressedLen && head === 4) {
        const x = Fp.fromBytes(tail.subarray(0, Fp.BYTES));
        const y = Fp.fromBytes(tail.subarray(Fp.BYTES, 2 * Fp.BYTES));
        return { x, y };
      } else {
        const cl = compressedLen;
        const ul = uncompressedLen;
        throw new Error("invalid Point, expected length of " + cl + ", or uncompressed " + ul + ", got " + len);
      }
    }
  });
  function isBiggerThanHalfOrder(number) {
    const HALF = CURVE_ORDER >> _1n5;
    return number > HALF;
  }
  function normalizeS(s) {
    return isBiggerThanHalfOrder(s) ? modN2(-s) : s;
  }
  const slcNum = (b, from, to) => bytesToNumberBE(b.slice(from, to));
  class Signature {
    constructor(r, s, recovery) {
      aInRange("r", r, _1n5, CURVE_ORDER);
      aInRange("s", s, _1n5, CURVE_ORDER);
      this.r = r;
      this.s = s;
      if (recovery != null)
        this.recovery = recovery;
      Object.freeze(this);
    }
    // pair (bytes of r, bytes of s)
    static fromCompact(hex) {
      const l = nByteLength;
      hex = ensureBytes("compactSignature", hex, l * 2);
      return new Signature(slcNum(hex, 0, l), slcNum(hex, l, 2 * l));
    }
    // DER encoded ECDSA signature
    // https://bitcoin.stackexchange.com/questions/57644/what-are-the-parts-of-a-bitcoin-transaction-input-script
    static fromDER(hex) {
      const { r, s } = DER.toSig(ensureBytes("DER", hex));
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
      if (radj >= Fp.ORDER)
        throw new Error("recovery id 2 or 3 invalid");
      const prefix = (rec & 1) === 0 ? "02" : "03";
      const R = Point2.fromHex(prefix + numToSizedHex(radj, Fp.BYTES));
      const ir = invN(radj);
      const u1 = modN2(-h * ir);
      const u2 = modN2(s * ir);
      const Q = Point2.BASE.multiplyAndAddUnsafe(R, u1, u2);
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
      return this.hasHighS() ? new Signature(this.r, modN2(-this.s), this.recovery) : this;
    }
    // DER-encoded
    toDERRawBytes() {
      return hexToBytes2(this.toDERHex());
    }
    toDERHex() {
      return DER.hexFromSig(this);
    }
    // padded bytes of r, then padded bytes of s
    toCompactRawBytes() {
      return hexToBytes2(this.toCompactHex());
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
    precompute(windowSize = 8, point = Point2.BASE) {
      point._setWindowSize(windowSize);
      point.multiply(BigInt(3));
      return point;
    }
  };
  function getPublicKey(privateKey, isCompressed = true) {
    return Point2.fromPrivateKey(privateKey).toRawBytes(isCompressed);
  }
  function isProbPub(item) {
    if (typeof item === "bigint")
      return false;
    if (item instanceof Point2)
      return true;
    const arr = ensureBytes("key", item);
    const len = arr.length;
    const fpl = Fp.BYTES;
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
    const b = Point2.fromHex(publicB);
    return b.multiply(normPrivateKeyToScalar(privateA)).toRawBytes(isCompressed);
  }
  const bits2int = CURVE.bits2int || function(bytes) {
    if (bytes.length > 8192)
      throw new Error("input is too large");
    const num2 = bytesToNumberBE(bytes);
    const delta = bytes.length * 8 - nBitLength;
    return delta > 0 ? num2 >> BigInt(delta) : num2;
  };
  const bits2int_modN = CURVE.bits2int_modN || function(bytes) {
    return modN2(bits2int(bytes));
  };
  const ORDER_MASK = bitMask(nBitLength);
  function int2octets(num2) {
    aInRange("num < 2^" + nBitLength, num2, _0n5, ORDER_MASK);
    return numberToBytesBE(num2, nByteLength);
  }
  function prepSig(msgHash, privateKey, opts = defaultSigOpts) {
    if (["recovered", "canonical"].some((k) => k in opts))
      throw new Error("sign() legacy options not supported");
    const { hash: hash2, randomBytes: randomBytes2 } = CURVE;
    let { lowS, prehash, extraEntropy: ent } = opts;
    if (lowS == null)
      lowS = true;
    msgHash = ensureBytes("msgHash", msgHash);
    validateSigVerOpts(opts);
    if (prehash)
      msgHash = ensureBytes("prehashed msgHash", hash2(msgHash));
    const h1int = bits2int_modN(msgHash);
    const d = normPrivateKeyToScalar(privateKey);
    const seedArgs = [int2octets(d), int2octets(h1int)];
    if (ent != null && ent !== false) {
      const e = ent === true ? randomBytes2(Fp.BYTES) : ent;
      seedArgs.push(ensureBytes("extraEntropy", e));
    }
    const seed = concatBytes3(...seedArgs);
    const m = h1int;
    function k2sig(kBytes) {
      const k = bits2int(kBytes);
      if (!isWithinCurveOrder(k))
        return;
      const ik = invN(k);
      const q = Point2.BASE.multiply(k).toAffine();
      const r = modN2(q.x);
      if (r === _0n5)
        return;
      const s = modN2(ik * modN2(m + r * d));
      if (s === _0n5)
        return;
      let recovery = (q.x === r ? 0 : 2) | Number(q.y & _1n5);
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
  Point2.BASE._setWindowSize(8);
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
    const isHex2 = typeof sg === "string" || isBytes2(sg);
    const isObj = !isHex2 && !format && typeof sg === "object" && sg !== null && typeof sg.r === "bigint" && typeof sg.s === "bigint";
    if (!isHex2 && !isObj)
      throw new Error("invalid signature, expected Uint8Array, hex string or Signature instance");
    let _sig = void 0;
    let P;
    try {
      if (isObj)
        _sig = new Signature(sg.r, sg.s);
      if (isHex2) {
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
      P = Point2.fromHex(publicKey);
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
    const u1 = modN2(h * is);
    const u2 = modN2(r * is);
    const R = Point2.BASE.multiplyAndAddUnsafe(P, u1, u2)?.toAffine();
    if (!R)
      return false;
    const v = modN2(R.x);
    return v === r;
  }
  return {
    CURVE,
    getPublicKey,
    getSharedSecret,
    sign,
    verify,
    ProjectivePoint: Point2,
    Signature,
    utils
  };
}
function SWUFpSqrtRatio(Fp, Z) {
  const q = Fp.ORDER;
  let l = _0n5;
  for (let o = q - _1n5; o % _2n3 === _0n5; o /= _2n3)
    l += _1n5;
  const c1 = l;
  const _2n_pow_c1_1 = _2n3 << c1 - _1n5 - _1n5;
  const _2n_pow_c1 = _2n_pow_c1_1 * _2n3;
  const c2 = (q - _1n5) / _2n_pow_c1;
  const c3 = (c2 - _1n5) / _2n3;
  const c4 = _2n_pow_c1 - _1n5;
  const c5 = _2n_pow_c1_1;
  const c6 = Fp.pow(Z, c2);
  const c7 = Fp.pow(Z, (c2 + _1n5) / _2n3);
  let sqrtRatio = (u, v) => {
    let tv1 = c6;
    let tv2 = Fp.pow(v, c4);
    let tv3 = Fp.sqr(tv2);
    tv3 = Fp.mul(tv3, v);
    let tv5 = Fp.mul(u, tv3);
    tv5 = Fp.pow(tv5, c3);
    tv5 = Fp.mul(tv5, tv2);
    tv2 = Fp.mul(tv5, v);
    tv3 = Fp.mul(tv5, u);
    let tv4 = Fp.mul(tv3, tv2);
    tv5 = Fp.pow(tv4, c5);
    let isQR = Fp.eql(tv5, Fp.ONE);
    tv2 = Fp.mul(tv3, c7);
    tv5 = Fp.mul(tv4, tv1);
    tv3 = Fp.cmov(tv2, tv3, isQR);
    tv4 = Fp.cmov(tv5, tv4, isQR);
    for (let i = c1; i > _1n5; i--) {
      let tv52 = i - _2n3;
      tv52 = _2n3 << tv52 - _1n5;
      let tvv5 = Fp.pow(tv4, tv52);
      const e1 = Fp.eql(tvv5, Fp.ONE);
      tv2 = Fp.mul(tv3, tv1);
      tv1 = Fp.mul(tv1, tv1);
      tvv5 = Fp.mul(tv4, tv1);
      tv3 = Fp.cmov(tv2, tv3, e1);
      tv4 = Fp.cmov(tvv5, tv4, e1);
    }
    return { isValid: isQR, value: tv3 };
  };
  if (Fp.ORDER % _4n2 === _3n2) {
    const c12 = (Fp.ORDER - _3n2) / _4n2;
    const c22 = Fp.sqrt(Fp.neg(Z));
    sqrtRatio = (u, v) => {
      let tv1 = Fp.sqr(v);
      const tv2 = Fp.mul(u, v);
      tv1 = Fp.mul(tv1, tv2);
      let y1 = Fp.pow(tv1, c12);
      y1 = Fp.mul(y1, tv2);
      const y2 = Fp.mul(y1, c22);
      const tv3 = Fp.mul(Fp.sqr(y1), v);
      const isQR = Fp.eql(tv3, u);
      let y = Fp.cmov(y2, y1, isQR);
      return { isValid: isQR, value: y };
    };
  }
  return sqrtRatio;
}
function mapToCurveSimpleSWU(Fp, opts) {
  validateField(Fp);
  if (!Fp.isValid(opts.A) || !Fp.isValid(opts.B) || !Fp.isValid(opts.Z))
    throw new Error("mapToCurveSimpleSWU: invalid opts");
  const sqrtRatio = SWUFpSqrtRatio(Fp, opts.Z);
  if (!Fp.isOdd)
    throw new Error("Fp.isOdd is not implemented!");
  return (u) => {
    let tv1, tv2, tv3, tv4, tv5, tv6, x, y;
    tv1 = Fp.sqr(u);
    tv1 = Fp.mul(tv1, opts.Z);
    tv2 = Fp.sqr(tv1);
    tv2 = Fp.add(tv2, tv1);
    tv3 = Fp.add(tv2, Fp.ONE);
    tv3 = Fp.mul(tv3, opts.B);
    tv4 = Fp.cmov(opts.Z, Fp.neg(tv2), !Fp.eql(tv2, Fp.ZERO));
    tv4 = Fp.mul(tv4, opts.A);
    tv2 = Fp.sqr(tv3);
    tv6 = Fp.sqr(tv4);
    tv5 = Fp.mul(tv6, opts.A);
    tv2 = Fp.add(tv2, tv5);
    tv2 = Fp.mul(tv2, tv3);
    tv6 = Fp.mul(tv6, tv4);
    tv5 = Fp.mul(tv6, opts.B);
    tv2 = Fp.add(tv2, tv5);
    x = Fp.mul(tv1, tv3);
    const { isValid, value } = sqrtRatio(tv2, tv6);
    y = Fp.mul(tv1, u);
    y = Fp.mul(y, value);
    x = Fp.cmov(x, tv3, isValid);
    y = Fp.cmov(y, value, isValid);
    const e1 = Fp.isOdd(u) === Fp.isOdd(y);
    y = Fp.cmov(Fp.neg(y), y, e1);
    const tv4_inv = FpInvertBatch(Fp, [tv4], true)[0];
    x = Fp.mul(x, tv4_inv);
    return { x, y };
  };
}
var DERErr, DER, _0n5, _1n5, _2n3, _3n2, _4n2;
var init_weierstrass = __esm({
  "../../enclave/node_modules/@noble/curves/esm/abstract/weierstrass.js"() {
    init_curve();
    init_modular();
    init_utils3();
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
            const lengthBytes = data.subarray(pos, pos + lenLen);
            if (lengthBytes.length !== lenLen)
              throw new E("tlv.decode: length bytes not complete");
            if (lengthBytes[0] === 0)
              throw new E("tlv.decode(long): zero leftmost byte");
            for (const b of lengthBytes)
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
        encode(num2) {
          const { Err: E } = DER;
          if (num2 < _0n5)
            throw new E("integer: negative integers are not allowed");
          let hex = numberToHexUnpadded(num2);
          if (Number.parseInt(hex[0], 16) & 8)
            hex = "00" + hex;
          if (hex.length & 1)
            throw new E("unexpected DER parsing assertion: unpadded hex");
          return hex;
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
      toSig(hex) {
        const { Err: E, _int: int, _tlv: tlv } = DER;
        const data = ensureBytes("signature", hex);
        const { v: seqBytes, l: seqLeftBytes } = tlv.decode(48, data);
        if (seqLeftBytes.length)
          throw new E("invalid signature: left bytes after parsing");
        const { v: rBytes, l: rLeftBytes } = tlv.decode(2, seqBytes);
        const { v: sBytes, l: sLeftBytes } = tlv.decode(2, rLeftBytes);
        if (sLeftBytes.length)
          throw new E("invalid signature: left bytes after parsing");
        return { r: int.decode(rBytes), s: int.decode(sBytes) };
      },
      hexFromSig(sig) {
        const { _tlv: tlv, _int: int } = DER;
        const rs = tlv.encode(2, int.encode(sig.r));
        const ss = tlv.encode(2, int.encode(sig.s));
        const seq = rs + ss;
        return tlv.encode(48, seq);
      }
    };
    _0n5 = BigInt(0);
    _1n5 = BigInt(1);
    _2n3 = BigInt(2);
    _3n2 = BigInt(3);
    _4n2 = BigInt(4);
  }
});

// ../../enclave/node_modules/@noble/curves/esm/_shortw_utils.js
function getHash(hash2) {
  return {
    hash: hash2,
    hmac: (key, ...msgs) => hmac(hash2, key, concatBytes(...msgs)),
    randomBytes
  };
}
function createCurve(curveDef, defHash) {
  const create = (hash2) => weierstrass({ ...curveDef, ...getHash(hash2) });
  return { ...create(defHash), create };
}
var init_shortw_utils = __esm({
  "../../enclave/node_modules/@noble/curves/esm/_shortw_utils.js"() {
    init_hmac();
    init_utils2();
    init_weierstrass();
  }
});

// ../../enclave/node_modules/@noble/curves/esm/abstract/hash-to-curve.js
function i2osp(value, length) {
  anum(value);
  anum(length);
  if (value < 0 || value >= 1 << 8 * length)
    throw new Error("invalid I2OSP input: " + value);
  const res = Array.from({ length }).fill(0);
  for (let i = length - 1; i >= 0; i--) {
    res[i] = value & 255;
    value >>>= 8;
  }
  return new Uint8Array(res);
}
function strxor(a, b) {
  const arr = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) {
    arr[i] = a[i] ^ b[i];
  }
  return arr;
}
function anum(item) {
  if (!Number.isSafeInteger(item))
    throw new Error("number expected");
}
function expand_message_xmd(msg, DST, lenInBytes, H) {
  abytes2(msg);
  abytes2(DST);
  anum(lenInBytes);
  if (DST.length > 255)
    DST = H(concatBytes3(utf8ToBytes2("H2C-OVERSIZE-DST-"), DST));
  const { outputLen: b_in_bytes, blockLen: r_in_bytes } = H;
  const ell = Math.ceil(lenInBytes / b_in_bytes);
  if (lenInBytes > 65535 || ell > 255)
    throw new Error("expand_message_xmd: invalid lenInBytes");
  const DST_prime = concatBytes3(DST, i2osp(DST.length, 1));
  const Z_pad = i2osp(0, r_in_bytes);
  const l_i_b_str = i2osp(lenInBytes, 2);
  const b = new Array(ell);
  const b_0 = H(concatBytes3(Z_pad, msg, l_i_b_str, i2osp(0, 1), DST_prime));
  b[0] = H(concatBytes3(b_0, i2osp(1, 1), DST_prime));
  for (let i = 1; i <= ell; i++) {
    const args = [strxor(b_0, b[i - 1]), i2osp(i + 1, 1), DST_prime];
    b[i] = H(concatBytes3(...args));
  }
  const pseudo_random_bytes = concatBytes3(...b);
  return pseudo_random_bytes.slice(0, lenInBytes);
}
function expand_message_xof(msg, DST, lenInBytes, k, H) {
  abytes2(msg);
  abytes2(DST);
  anum(lenInBytes);
  if (DST.length > 255) {
    const dkLen = Math.ceil(2 * k / 8);
    DST = H.create({ dkLen }).update(utf8ToBytes2("H2C-OVERSIZE-DST-")).update(DST).digest();
  }
  if (lenInBytes > 65535 || DST.length > 255)
    throw new Error("expand_message_xof: invalid lenInBytes");
  return H.create({ dkLen: lenInBytes }).update(msg).update(i2osp(lenInBytes, 2)).update(DST).update(i2osp(DST.length, 1)).digest();
}
function hash_to_field(msg, count, options) {
  validateObject(options, {
    DST: "stringOrUint8Array",
    p: "bigint",
    m: "isSafeInteger",
    k: "isSafeInteger",
    hash: "hash"
  });
  const { p, k, m, hash: hash2, expand, DST: _DST } = options;
  abytes2(msg);
  anum(count);
  const DST = typeof _DST === "string" ? utf8ToBytes2(_DST) : _DST;
  const log2p = p.toString(2).length;
  const L = Math.ceil((log2p + k) / 8);
  const len_in_bytes = count * m * L;
  let prb;
  if (expand === "xmd") {
    prb = expand_message_xmd(msg, DST, len_in_bytes, hash2);
  } else if (expand === "xof") {
    prb = expand_message_xof(msg, DST, len_in_bytes, k, hash2);
  } else if (expand === "_internal_pass") {
    prb = msg;
  } else {
    throw new Error('expand must be "xmd" or "xof"');
  }
  const u = new Array(count);
  for (let i = 0; i < count; i++) {
    const e = new Array(m);
    for (let j = 0; j < m; j++) {
      const elm_offset = L * (j + i * m);
      const tv = prb.subarray(elm_offset, elm_offset + L);
      e[j] = mod(os2ip(tv), p);
    }
    u[i] = e;
  }
  return u;
}
function isogenyMap(field, map) {
  const coeff = map.map((i) => Array.from(i).reverse());
  return (x, y) => {
    const [xn, xd, yn, yd] = coeff.map((val) => val.reduce((acc, i) => field.add(field.mul(acc, x), i)));
    const [xd_inv, yd_inv] = FpInvertBatch(field, [xd, yd], true);
    x = field.mul(xn, xd_inv);
    y = field.mul(y, field.mul(yn, yd_inv));
    return { x, y };
  };
}
function createHasher2(Point2, mapToCurve, defaults) {
  if (typeof mapToCurve !== "function")
    throw new Error("mapToCurve() must be defined");
  function map(num2) {
    return Point2.fromAffine(mapToCurve(num2));
  }
  function clear(initial) {
    const P = initial.clearCofactor();
    if (P.equals(Point2.ZERO))
      return Point2.ZERO;
    P.assertValidity();
    return P;
  }
  return {
    defaults,
    // Encodes byte string to elliptic curve.
    // hash_to_curve from https://www.rfc-editor.org/rfc/rfc9380#section-3
    hashToCurve(msg, options) {
      const u = hash_to_field(msg, 2, { ...defaults, DST: defaults.DST, ...options });
      const u0 = map(u[0]);
      const u1 = map(u[1]);
      return clear(u0.add(u1));
    },
    // Encodes byte string to elliptic curve.
    // encode_to_curve from https://www.rfc-editor.org/rfc/rfc9380#section-3
    encodeToCurve(msg, options) {
      const u = hash_to_field(msg, 1, { ...defaults, DST: defaults.encodeDST, ...options });
      return clear(map(u[0]));
    },
    // Same as encodeToCurve, but without hash
    mapToCurve(scalars) {
      if (!Array.isArray(scalars))
        throw new Error("expected array of bigints");
      for (const i of scalars)
        if (typeof i !== "bigint")
          throw new Error("expected array of bigints");
      return clear(map(scalars));
    }
  };
}
var os2ip;
var init_hash_to_curve = __esm({
  "../../enclave/node_modules/@noble/curves/esm/abstract/hash-to-curve.js"() {
    init_modular();
    init_utils3();
    os2ip = bytesToNumberBE;
  }
});

// ../../enclave/node_modules/@noble/curves/esm/secp256k1.js
var secp256k1_exports = {};
__export(secp256k1_exports, {
  encodeToCurve: () => encodeToCurve,
  hashToCurve: () => hashToCurve,
  schnorr: () => schnorr,
  secp256k1: () => secp256k1,
  secp256k1_hasher: () => secp256k1_hasher
});
function sqrtMod(y) {
  const P = secp256k1P;
  const _3n3 = BigInt(3), _6n = BigInt(6), _11n = BigInt(11), _22n = BigInt(22);
  const _23n = BigInt(23), _44n = BigInt(44), _88n = BigInt(88);
  const b2 = y * y * y % P;
  const b3 = b2 * b2 * y % P;
  const b6 = pow2(b3, _3n3, P) * b3 % P;
  const b9 = pow2(b6, _3n3, P) * b3 % P;
  const b11 = pow2(b9, _2n4, P) * b2 % P;
  const b22 = pow2(b11, _11n, P) * b11 % P;
  const b44 = pow2(b22, _22n, P) * b22 % P;
  const b88 = pow2(b44, _44n, P) * b44 % P;
  const b176 = pow2(b88, _88n, P) * b88 % P;
  const b220 = pow2(b176, _44n, P) * b44 % P;
  const b223 = pow2(b220, _3n3, P) * b3 % P;
  const t1 = pow2(b223, _23n, P) * b22 % P;
  const t2 = pow2(t1, _6n, P) * b2 % P;
  const root = pow2(t2, _2n4, P);
  if (!Fpk1.eql(Fpk1.sqr(root), y))
    throw new Error("Cannot find square root");
  return root;
}
function taggedHash(tag, ...messages) {
  let tagP = TAGGED_HASH_PREFIXES[tag];
  if (tagP === void 0) {
    const tagH = sha256(Uint8Array.from(tag, (c) => c.charCodeAt(0)));
    tagP = concatBytes3(tagH, tagH);
    TAGGED_HASH_PREFIXES[tag] = tagP;
  }
  return sha256(concatBytes3(tagP, ...messages));
}
function schnorrGetExtPubKey(priv) {
  let d_ = secp256k1.utils.normPrivateKeyToScalar(priv);
  let p = Point.fromPrivateKey(d_);
  const scalar = p.hasEvenY() ? d_ : modN(-d_);
  return { scalar, bytes: pointToBytes(p) };
}
function lift_x(x) {
  aInRange("x", x, _1n6, secp256k1P);
  const xx = modP(x * x);
  const c = modP(xx * x + BigInt(7));
  let y = sqrtMod(c);
  if (y % _2n4 !== _0n6)
    y = modP(-y);
  const p = new Point(x, y, _1n6);
  p.assertValidity();
  return p;
}
function challenge(...args) {
  return modN(num(taggedHash("BIP0340/challenge", ...args)));
}
function schnorrGetPublicKey(privateKey) {
  return schnorrGetExtPubKey(privateKey).bytes;
}
function schnorrSign(message, privateKey, auxRand = randomBytes(32)) {
  const m = ensureBytes("message", message);
  const { bytes: px, scalar: d } = schnorrGetExtPubKey(privateKey);
  const a = ensureBytes("auxRand", auxRand, 32);
  const t = numTo32b(d ^ num(taggedHash("BIP0340/aux", a)));
  const rand = taggedHash("BIP0340/nonce", t, px, m);
  const k_ = modN(num(rand));
  if (k_ === _0n6)
    throw new Error("sign failed: k is zero");
  const { bytes: rx, scalar: k } = schnorrGetExtPubKey(k_);
  const e = challenge(rx, px, m);
  const sig = new Uint8Array(64);
  sig.set(rx, 0);
  sig.set(numTo32b(modN(k + e * d)), 32);
  if (!schnorrVerify(sig, m, px))
    throw new Error("sign: Invalid signature produced");
  return sig;
}
function schnorrVerify(signature, message, publicKey) {
  const sig = ensureBytes("signature", signature, 64);
  const m = ensureBytes("message", message);
  const pub = ensureBytes("publicKey", publicKey, 32);
  try {
    const P = lift_x(num(pub));
    const r = num(sig.subarray(0, 32));
    if (!inRange(r, _1n6, secp256k1P))
      return false;
    const s = num(sig.subarray(32, 64));
    if (!inRange(s, _1n6, secp256k1N))
      return false;
    const e = challenge(numTo32b(r), pointToBytes(P), m);
    const R = GmulAdd(P, s, modN(-e));
    if (!R || !R.hasEvenY() || R.toAffine().x !== r)
      return false;
    return true;
  } catch (error) {
    return false;
  }
}
var secp256k1P, secp256k1N, _0n6, _1n6, _2n4, divNearest, Fpk1, secp256k1, TAGGED_HASH_PREFIXES, pointToBytes, numTo32b, modP, modN, Point, GmulAdd, num, schnorr, isoMap, mapSWU, secp256k1_hasher, hashToCurve, encodeToCurve;
var init_secp256k1 = __esm({
  "../../enclave/node_modules/@noble/curves/esm/secp256k1.js"() {
    init_sha2();
    init_utils2();
    init_shortw_utils();
    init_hash_to_curve();
    init_modular();
    init_utils3();
    init_weierstrass();
    secp256k1P = BigInt("0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f");
    secp256k1N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
    _0n6 = BigInt(0);
    _1n6 = BigInt(1);
    _2n4 = BigInt(2);
    divNearest = (a, b) => (a + b / _2n4) / b;
    Fpk1 = Field(secp256k1P, void 0, void 0, { sqrt: sqrtMod });
    secp256k1 = createCurve({
      a: _0n6,
      b: BigInt(7),
      Fp: Fpk1,
      n: secp256k1N,
      Gx: BigInt("55066263022277343669578718895168534326250603453777594175500187360389116729240"),
      Gy: BigInt("32670510020758816978083085130507043184471273380659243275938904335757337482424"),
      h: BigInt(1),
      lowS: true,
      // Allow only low-S signatures by default in sign() and verify()
      endo: {
        // Endomorphism, see above
        beta: BigInt("0x7ae96a2b657c07106e64479eac3434e99cf0497512f58995c1396c28719501ee"),
        splitScalar: (k) => {
          const n = secp256k1N;
          const a1 = BigInt("0x3086d221a7d46bcde86c90e49284eb15");
          const b1 = -_1n6 * BigInt("0xe4437ed6010e88286f547fa90abfe4c3");
          const a2 = BigInt("0x114ca50f7a8e2f3f657c1108d9d44cfd8");
          const b2 = a1;
          const POW_2_128 = BigInt("0x100000000000000000000000000000000");
          const c1 = divNearest(b2 * k, n);
          const c2 = divNearest(-b1 * k, n);
          let k1 = mod(k - c1 * a1 - c2 * a2, n);
          let k2 = mod(-c1 * b1 - c2 * b2, n);
          const k1neg = k1 > POW_2_128;
          const k2neg = k2 > POW_2_128;
          if (k1neg)
            k1 = n - k1;
          if (k2neg)
            k2 = n - k2;
          if (k1 > POW_2_128 || k2 > POW_2_128) {
            throw new Error("splitScalar: Endomorphism failed, k=" + k);
          }
          return { k1neg, k1, k2neg, k2 };
        }
      }
    }, sha256);
    TAGGED_HASH_PREFIXES = {};
    pointToBytes = (point) => point.toRawBytes(true).slice(1);
    numTo32b = (n) => numberToBytesBE(n, 32);
    modP = (x) => mod(x, secp256k1P);
    modN = (x) => mod(x, secp256k1N);
    Point = /* @__PURE__ */ (() => secp256k1.ProjectivePoint)();
    GmulAdd = (Q, a, b) => Point.BASE.multiplyAndAddUnsafe(Q, a, b);
    num = bytesToNumberBE;
    schnorr = /* @__PURE__ */ (() => ({
      getPublicKey: schnorrGetPublicKey,
      sign: schnorrSign,
      verify: schnorrVerify,
      utils: {
        randomPrivateKey: secp256k1.utils.randomPrivateKey,
        lift_x,
        pointToBytes,
        numberToBytesBE,
        bytesToNumberBE,
        taggedHash,
        mod
      }
    }))();
    isoMap = /* @__PURE__ */ (() => isogenyMap(Fpk1, [
      // xNum
      [
        "0x8e38e38e38e38e38e38e38e38e38e38e38e38e38e38e38e38e38e38daaaaa8c7",
        "0x7d3d4c80bc321d5b9f315cea7fd44c5d595d2fc0bf63b92dfff1044f17c6581",
        "0x534c328d23f234e6e2a413deca25caece4506144037c40314ecbd0b53d9dd262",
        "0x8e38e38e38e38e38e38e38e38e38e38e38e38e38e38e38e38e38e38daaaaa88c"
      ],
      // xDen
      [
        "0xd35771193d94918a9ca34ccbb7b640dd86cd409542f8487d9fe6b745781eb49b",
        "0xedadc6f64383dc1df7c4b2d51b54225406d36b641f5e41bbc52a56612a8c6d14",
        "0x0000000000000000000000000000000000000000000000000000000000000001"
        // LAST 1
      ],
      // yNum
      [
        "0x4bda12f684bda12f684bda12f684bda12f684bda12f684bda12f684b8e38e23c",
        "0xc75e0c32d5cb7c0fa9d0a54b12a0a6d5647ab046d686da6fdffc90fc201d71a3",
        "0x29a6194691f91a73715209ef6512e576722830a201be2018a765e85a9ecee931",
        "0x2f684bda12f684bda12f684bda12f684bda12f684bda12f684bda12f38e38d84"
      ],
      // yDen
      [
        "0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffff93b",
        "0x7a06534bb8bdb49fd5e9e6632722c2989467c1bfc8e8d978dfb425d2685c2573",
        "0x6484aa716545ca2cf3a70c3fa8fe337e0a3d21162f0d6299a7bf8192bfd2a76f",
        "0x0000000000000000000000000000000000000000000000000000000000000001"
        // LAST 1
      ]
    ].map((i) => i.map((j) => BigInt(j)))))();
    mapSWU = /* @__PURE__ */ (() => mapToCurveSimpleSWU(Fpk1, {
      A: BigInt("0x3f8731abdd661adca08a5558f0f5d272e953d363cb6f0e5d405447c01a444533"),
      B: BigInt("1771"),
      Z: Fpk1.create(BigInt("-11"))
    }))();
    secp256k1_hasher = /* @__PURE__ */ (() => createHasher2(secp256k1.ProjectivePoint, (scalars) => {
      const { x, y } = mapSWU(Fpk1.create(scalars[0]));
      return isoMap(x, y);
    }, {
      DST: "secp256k1_XMD:SHA-256_SSWU_RO_",
      encodeDST: "secp256k1_XMD:SHA-256_SSWU_NU_",
      p: Fpk1.ORDER,
      m: 1,
      k: 128,
      expand: "xmd",
      hash: sha256
    }))();
    hashToCurve = /* @__PURE__ */ (() => secp256k1_hasher.hashToCurve)();
    encodeToCurve = /* @__PURE__ */ (() => secp256k1_hasher.encodeToCurve)();
  }
});

// ../../enclave/node_modules/viem/_esm/utils/abi/decodeFunctionResult.js
function decodeFunctionResult(parameters) {
  const { abi, args, functionName, data } = parameters;
  let abiItem = abi[0];
  if (functionName) {
    const item = getAbiItem({ abi, args, name: functionName });
    if (!item)
      throw new AbiFunctionNotFoundError(functionName, { docsPath: docsPath4 });
    abiItem = item;
  }
  if (abiItem.type !== "function")
    throw new AbiFunctionNotFoundError(void 0, { docsPath: docsPath4 });
  if (!abiItem.outputs)
    throw new AbiFunctionOutputsNotFoundError(abiItem.name, { docsPath: docsPath4 });
  const values = decodeAbiParameters(abiItem.outputs, data);
  if (values && values.length > 1)
    return values;
  if (values && values.length === 1)
    return values[0];
  return void 0;
}
var docsPath4;
var init_decodeFunctionResult = __esm({
  "../../enclave/node_modules/viem/_esm/utils/abi/decodeFunctionResult.js"() {
    init_abi();
    init_decodeAbiParameters();
    init_getAbiItem();
    docsPath4 = "/docs/contract/decodeFunctionResult";
  }
});

// ../../enclave/node_modules/viem/_esm/utils/abi/decodeFunctionData.js
function decodeFunctionData(parameters) {
  const { abi, data } = parameters;
  const signature = slice(data, 0, 4);
  const description = abi.find((x) => x.type === "function" && signature === toFunctionSelector(formatAbiItem2(x)));
  if (!description)
    throw new AbiFunctionSignatureNotFoundError(signature, {
      docsPath: "/docs/contract/decodeFunctionData"
    });
  return {
    functionName: description.name,
    args: "inputs" in description && description.inputs && description.inputs.length > 0 ? decodeAbiParameters(description.inputs, slice(data, 4)) : void 0
  };
}
var init_decodeFunctionData = __esm({
  "../../enclave/node_modules/viem/_esm/utils/abi/decodeFunctionData.js"() {
    init_abi();
    init_slice();
    init_toFunctionSelector();
    init_decodeAbiParameters();
    init_formatAbiItem2();
  }
});

// ../../enclave/node_modules/viem/_esm/index.js
init_exports();

// ../../enclave/node_modules/viem/_esm/utils/abi/encodeEventTopics.js
init_abi();

// ../../enclave/node_modules/viem/_esm/errors/log.js
init_base();
var FilterTypeNotSupportedError = class extends BaseError2 {
  constructor(type) {
    super(`Filter type "${type}" is not supported.`, {
      name: "FilterTypeNotSupportedError"
    });
  }
};

// ../../enclave/node_modules/viem/_esm/utils/abi/encodeEventTopics.js
init_toBytes();
init_keccak256();
init_toEventSelector();
init_encodeAbiParameters();
init_formatAbiItem2();
init_getAbiItem();
var docsPath = "/docs/contract/encodeEventTopics";
function encodeEventTopics(parameters) {
  const { abi, eventName, args } = parameters;
  let abiItem = abi[0];
  if (eventName) {
    const item = getAbiItem({ abi, name: eventName });
    if (!item)
      throw new AbiEventNotFoundError(eventName, { docsPath });
    abiItem = item;
  }
  if (abiItem.type !== "event")
    throw new AbiEventNotFoundError(void 0, { docsPath });
  let topics = [];
  if (args && "inputs" in abiItem) {
    const indexedInputs = abiItem.inputs?.filter((param) => "indexed" in param && param.indexed);
    const args_ = Array.isArray(args) ? args : Object.values(args).length > 0 ? indexedInputs?.map((x) => args[x.name]) ?? [] : [];
    if (args_.length > 0) {
      topics = indexedInputs?.map((param, i) => {
        if (Array.isArray(args_[i]))
          return args_[i].map((_, j) => encodeArg({ param, value: args_[i][j] }));
        return typeof args_[i] !== "undefined" && args_[i] !== null ? encodeArg({ param, value: args_[i] }) : null;
      }) ?? [];
    }
  }
  if (abiItem.anonymous)
    return topics;
  const definition = formatAbiItem2(abiItem);
  const signature = toEventSelector(definition);
  return [signature, ...topics];
}
function encodeArg({ param, value }) {
  if (param.type === "string" || param.type === "bytes")
    return keccak256(toBytes(value));
  if (param.type === "tuple" || param.type.match(/^(.*)\[(\d+)?\]$/))
    throw new FilterTypeNotSupportedError(param.type);
  return encodeAbiParameters([param], [value]);
}

// ../../enclave/node_modules/viem/_esm/accounts/utils/publicKeyToAddress.js
init_getAddress();
init_keccak256();
function publicKeyToAddress(publicKey) {
  const address = keccak256(`0x${publicKey.substring(4)}`).substring(26);
  return checksumAddress(`0x${address}`);
}

// ../../enclave/node_modules/viem/_esm/utils/signature/recoverPublicKey.js
init_isHex();
init_size();
init_fromHex();
init_toHex();
async function recoverPublicKey({ hash: hash2, signature }) {
  const hashHex = isHex(hash2) ? hash2 : toHex(hash2);
  const { secp256k1: secp256k12 } = await Promise.resolve().then(() => (init_secp256k1(), secp256k1_exports));
  const signature_ = (() => {
    if (typeof signature === "object" && "r" in signature && "s" in signature) {
      const { r, s, v, yParity } = signature;
      const yParityOrV2 = Number(yParity ?? v);
      const recoveryBit2 = toRecoveryBit(yParityOrV2);
      return new secp256k12.Signature(hexToBigInt(r), hexToBigInt(s)).addRecoveryBit(recoveryBit2);
    }
    const signatureHex = isHex(signature) ? signature : toHex(signature);
    if (size(signatureHex) !== 65)
      throw new Error("invalid signature length");
    const yParityOrV = hexToNumber(`0x${signatureHex.slice(130)}`);
    const recoveryBit = toRecoveryBit(yParityOrV);
    return secp256k12.Signature.fromCompact(signatureHex.substring(2, 130)).addRecoveryBit(recoveryBit);
  })();
  const publicKey = signature_.recoverPublicKey(hashHex.substring(2)).toHex(false);
  return `0x${publicKey}`;
}
function toRecoveryBit(yParityOrV) {
  if (yParityOrV === 0 || yParityOrV === 1)
    return yParityOrV;
  if (yParityOrV === 27)
    return 0;
  if (yParityOrV === 28)
    return 1;
  throw new Error("Invalid yParityOrV value");
}

// ../../enclave/node_modules/viem/_esm/utils/signature/recoverAddress.js
async function recoverAddress({ hash: hash2, signature }) {
  return publicKeyToAddress(await recoverPublicKey({ hash: hash2, signature }));
}

// ../../enclave/node_modules/viem/_esm/utils/abi/decodeEventLog.js
init_abi();
init_cursor();
init_size();
init_toEventSelector();
init_decodeAbiParameters();
init_formatAbiItem2();
var docsPath3 = "/docs/contract/decodeEventLog";
function decodeEventLog(parameters) {
  const { abi, data, strict: strict_, topics } = parameters;
  const strict = strict_ ?? true;
  const [signature, ...argTopics] = topics;
  if (!signature)
    throw new AbiEventSignatureEmptyTopicsError({ docsPath: docsPath3 });
  const abiItem = abi.find((x) => x.type === "event" && signature === toEventSelector(formatAbiItem2(x)));
  if (!(abiItem && "name" in abiItem) || abiItem.type !== "event")
    throw new AbiEventSignatureNotFoundError(signature, { docsPath: docsPath3 });
  const { name, inputs } = abiItem;
  const isUnnamed = inputs?.some((x) => !("name" in x && x.name));
  const args = isUnnamed ? [] : {};
  const indexedInputs = inputs.map((x, i) => [x, i]).filter(([x]) => "indexed" in x && x.indexed);
  const missingIndexedInputs = [];
  for (let i = 0; i < indexedInputs.length; i++) {
    const [param, argIndex] = indexedInputs[i];
    const topic = argTopics[i];
    if (!topic) {
      if (strict)
        throw new DecodeLogTopicsMismatch({
          abiItem,
          param
        });
      missingIndexedInputs.push([param, argIndex]);
      continue;
    }
    args[isUnnamed ? argIndex : param.name || argIndex] = decodeTopic({
      param,
      value: topic
    });
  }
  const nonIndexedInputs = inputs.filter((x) => !("indexed" in x && x.indexed));
  const inputsToDecode = strict ? nonIndexedInputs : [...missingIndexedInputs.map(([param]) => param), ...nonIndexedInputs];
  if (inputsToDecode.length > 0) {
    if (data && data !== "0x") {
      try {
        const decodedData = decodeAbiParameters(inputsToDecode, data);
        if (decodedData) {
          let dataIndex = 0;
          if (!strict) {
            for (const [param, argIndex] of missingIndexedInputs) {
              args[isUnnamed ? argIndex : param.name || argIndex] = decodedData[dataIndex++];
            }
          }
          if (isUnnamed) {
            for (let i = 0; i < inputs.length; i++)
              if (args[i] === void 0 && dataIndex < decodedData.length)
                args[i] = decodedData[dataIndex++];
          } else
            for (let i = 0; i < nonIndexedInputs.length; i++)
              args[nonIndexedInputs[i].name] = decodedData[dataIndex++];
        }
      } catch (err) {
        if (strict) {
          if (err instanceof AbiDecodingDataSizeTooSmallError || err instanceof PositionOutOfBoundsError)
            throw new DecodeLogDataMismatch({
              abiItem,
              data,
              params: inputsToDecode,
              size: size(data)
            });
          throw err;
        }
      }
    } else if (strict) {
      throw new DecodeLogDataMismatch({
        abiItem,
        data: "0x",
        params: inputsToDecode,
        size: 0
      });
    }
  }
  return {
    eventName: name,
    args: Object.values(args).length > 0 ? args : void 0
  };
}
function decodeTopic({ param, value }) {
  if (param.type === "string" || param.type === "bytes" || param.type === "tuple" || param.type.match(/^(.*)\[(\d+)?\]$/))
    return value;
  const decodedArg = decodeAbiParameters([param], value) || [];
  return decodedArg[0];
}

// ../../enclave/node_modules/viem/_esm/utils/signature/hashTypedData.js
init_encodeAbiParameters();
init_concat();
init_toHex();
init_keccak256();

// ../../enclave/node_modules/viem/_esm/utils/typedData.js
init_abi();
init_address();

// ../../enclave/node_modules/viem/_esm/errors/typedData.js
init_stringify();
init_base();
var InvalidDomainError = class extends BaseError2 {
  constructor({ domain }) {
    super(`Invalid domain "${stringify(domain)}".`, {
      metaMessages: ["Must be a valid EIP-712 domain."]
    });
  }
};
var InvalidPrimaryTypeError = class extends BaseError2 {
  constructor({ primaryType, types }) {
    super(`Invalid primary type \`${primaryType}\` must be one of \`${JSON.stringify(Object.keys(types))}\`.`, {
      docsPath: "/api/glossary/Errors#typeddatainvalidprimarytypeerror",
      metaMessages: ["Check that the primary type is a key in `types`."]
    });
  }
};
var InvalidStructTypeError = class extends BaseError2 {
  constructor({ type }) {
    super(`Struct type "${type}" is invalid.`, {
      metaMessages: ["Struct type must not be a Solidity type."],
      name: "InvalidStructTypeError"
    });
  }
};

// ../../enclave/node_modules/viem/_esm/utils/typedData.js
init_isAddress();
init_size();
init_toHex();
init_regex2();
function validateTypedData(parameters) {
  const { domain, message, primaryType, types } = parameters;
  const validateData = (struct, data) => {
    for (const param of struct) {
      const { name, type } = param;
      const value = data[name];
      const integerMatch = type.match(integerRegex2);
      if (integerMatch && (typeof value === "number" || typeof value === "bigint")) {
        const [_type, base, size_] = integerMatch;
        numberToHex(value, {
          signed: base === "int",
          size: Number.parseInt(size_, 10) / 8
        });
      }
      if (type === "address" && typeof value === "string" && !isAddress(value))
        throw new InvalidAddressError({ address: value });
      const bytesMatch = type.match(bytesRegex2);
      if (bytesMatch) {
        const [_type, size_] = bytesMatch;
        if (size_ && size(value) !== Number.parseInt(size_, 10))
          throw new BytesSizeMismatchError({
            expectedSize: Number.parseInt(size_, 10),
            givenSize: size(value)
          });
      }
      const struct2 = types[type];
      if (struct2) {
        validateReference(type);
        validateData(struct2, value);
      }
    }
  };
  if (types.EIP712Domain && domain) {
    if (typeof domain !== "object")
      throw new InvalidDomainError({ domain });
    validateData(types.EIP712Domain, domain);
  }
  if (primaryType !== "EIP712Domain") {
    if (types[primaryType])
      validateData(types[primaryType], message);
    else
      throw new InvalidPrimaryTypeError({ primaryType, types });
  }
}
function getTypesForEIP712Domain({ domain }) {
  return [
    typeof domain?.name === "string" && { name: "name", type: "string" },
    domain?.version && { name: "version", type: "string" },
    (typeof domain?.chainId === "number" || typeof domain?.chainId === "bigint") && {
      name: "chainId",
      type: "uint256"
    },
    domain?.verifyingContract && {
      name: "verifyingContract",
      type: "address"
    },
    domain?.salt && { name: "salt", type: "bytes32" }
  ].filter(Boolean);
}
function validateReference(type) {
  if (type === "address" || type === "bool" || type === "string" || type.startsWith("bytes") || type.startsWith("uint") || type.startsWith("int"))
    throw new InvalidStructTypeError({ type });
}

// ../../enclave/node_modules/viem/_esm/utils/signature/hashTypedData.js
function hashTypedData(parameters) {
  const { domain = {}, message, primaryType } = parameters;
  const types = {
    EIP712Domain: getTypesForEIP712Domain({ domain }),
    ...parameters.types
  };
  validateTypedData({
    domain,
    message,
    primaryType,
    types
  });
  const parts = ["0x1901"];
  if (domain)
    parts.push(hashDomain({
      domain,
      types
    }));
  if (primaryType !== "EIP712Domain")
    parts.push(hashStruct({
      data: message,
      primaryType,
      types
    }));
  return keccak256(concat(parts));
}
function hashDomain({ domain, types }) {
  return hashStruct({
    data: domain,
    primaryType: "EIP712Domain",
    types
  });
}
function hashStruct({ data, primaryType, types }) {
  const encoded = encodeData({
    data,
    primaryType,
    types
  });
  return keccak256(encoded);
}
function encodeData({ data, primaryType, types }) {
  const encodedTypes = [{ type: "bytes32" }];
  const encodedValues = [hashType({ primaryType, types })];
  for (const field of types[primaryType]) {
    const [type, value] = encodeField({
      types,
      name: field.name,
      type: field.type,
      value: data[field.name]
    });
    encodedTypes.push(type);
    encodedValues.push(value);
  }
  return encodeAbiParameters(encodedTypes, encodedValues);
}
function hashType({ primaryType, types }) {
  const encodedHashType = toHex(encodeType({ primaryType, types }));
  return keccak256(encodedHashType);
}
function encodeType({ primaryType, types }) {
  let result = "";
  const unsortedDeps = findTypeDependencies({ primaryType, types });
  unsortedDeps.delete(primaryType);
  const deps = [primaryType, ...Array.from(unsortedDeps).sort()];
  for (const type of deps) {
    result += `${type}(${types[type].map(({ name, type: t }) => `${t} ${name}`).join(",")})`;
  }
  return result;
}
function findTypeDependencies({ primaryType: primaryType_, types }, results = /* @__PURE__ */ new Set()) {
  const match = primaryType_.match(/^\w*/u);
  const primaryType = match?.[0];
  if (results.has(primaryType) || types[primaryType] === void 0) {
    return results;
  }
  results.add(primaryType);
  for (const field of types[primaryType]) {
    findTypeDependencies({ primaryType: field.type, types }, results);
  }
  return results;
}
function encodeField({ types, name, type, value }) {
  if (types[type] !== void 0) {
    return [
      { type: "bytes32" },
      keccak256(encodeData({ data: value, primaryType: type, types }))
    ];
  }
  if (type === "bytes")
    return [{ type: "bytes32" }, keccak256(value)];
  if (type === "string")
    return [{ type: "bytes32" }, keccak256(toHex(value))];
  if (type.lastIndexOf("]") === type.length - 1) {
    const parsedType = type.slice(0, type.lastIndexOf("["));
    const typeValuePairs = value.map((item) => encodeField({
      name,
      type: parsedType,
      types,
      value: item
    }));
    return [
      { type: "bytes32" },
      keccak256(encodeAbiParameters(typeValuePairs.map(([t]) => t), typeValuePairs.map(([, v]) => v)))
    ];
  }
  return [{ type }, value];
}

// ../../enclave/node_modules/viem/_esm/utils/signature/recoverTypedDataAddress.js
async function recoverTypedDataAddress(parameters) {
  const { domain, message, primaryType, signature, types } = parameters;
  return recoverAddress({
    hash: hashTypedData({
      domain,
      message,
      primaryType,
      types
    }),
    signature
  });
}

// ../../enclave/node_modules/viem/_esm/index.js
init_decodeAbiParameters();
init_decodeFunctionData();
init_decodeFunctionResult();
init_encodeAbiParameters();
init_encodeFunctionData();
init_getAddress();
init_toBytes();
init_toHex();
init_keccak256();

// sdk/funding/util.mjs
var MigrationError = class extends Error {
  constructor(code, message, detail) {
    super(`${code}: ${message}`);
    this.name = "MigrationError";
    this.code = code;
    this.detail = detail;
  }
};
var fail = (code, message, detail) => {
  throw new MigrationError(code, message, detail);
};
function canon(v) {
  if (typeof v === "bigint") return JSON.stringify(v.toString());
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) fail("canon_number", "only safe integers are serialised");
    return String(v);
  }
  if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (typeof v === "object") {
    const p = Object.getPrototypeOf(v);
    if (p !== Object.prototype && p !== null) fail("canon_type", "only plain objects are serialised");
    return `{${Object.keys(v).filter((k) => v[k] !== void 0).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`;
  }
  return fail("canon_type", `cannot serialise ${typeof v}`);
}
var jsonable = (v) => JSON.parse(canon(v));
var hashOf = (v) => keccak256(new TextEncoder().encode(canon(v)));
function randomHex32(c = globalThis.crypto) {
  if (!c || typeof c.getRandomValues !== "function") fail("webcrypto_missing", "crypto.getRandomValues is unavailable");
  const b = new Uint8Array(32);
  c.getRandomValues(b);
  const h = bytesToHex(b);
  if (h === `0x${"0".repeat(64)}`) fail("random_zero", "the random source returned zero");
  return h;
}
var SECRET_KEYS = /* @__PURE__ */ new Set(["sig", "ownerSig", "signature", "r", "s", "privateKey", "pkcs8", "deposit", "depositSig"]);
function assertPublic(v, path = "entry") {
  if (v !== null && typeof v === "object") {
    const p = Object.getPrototypeOf(v);
    if (!Array.isArray(v) && p !== Object.prototype && p !== null) fail("journal_secret", `${path} is not plain data`);
    for (const [k, x] of Object.entries(v)) {
      if (SECRET_KEYS.has(k)) fail("journal_secret", `${path}.${k} may not be journaled`);
      assertPublic(x, `${path}.${k}`);
    }
  }
  return v;
}
function normalizeWire(v) {
  if (typeof v === "string" && /^(0|[1-9][0-9]{0,77})n$/.test(v)) return v.slice(0, -1);
  if (Array.isArray(v)) return v.map(normalizeWire);
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalizeWire(x)]));
  return v;
}
function wireFetch(f) {
  return async (url, init) => {
    const r = await f(url, init);
    const text = await r.text();
    let body = text;
    try {
      body = JSON.stringify(normalizeWire(JSON.parse(text)));
    } catch {
    }
    return { ok: r.ok, status: r.status, text: async () => body };
  };
}
var lower = (a) => String(a ?? "").toLowerCase();
var nowSec = () => BigInt(Math.floor(Date.now() / 1e3));
var sameAddr = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

// sdk/funding/funding-codec.mjs
var FundingCodecError = class extends Error {
  constructor(code, message, detail) {
    super(`${code}: ${message}`);
    this.name = "FundingCodecError";
    this.code = code;
    this.detail = detail;
  }
};
var fail2 = (code, message, detail) => {
  throw new FundingCodecError(code, message, detail);
};
function deepFreeze(o) {
  if (o !== null && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}
var utf8 = new TextEncoder();
var hashString = (s) => keccak256(utf8.encode(s));
var has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
var max = (bits) => (1n << BigInt(bits)) - 1n;
var DOMAIN_NAME = "Enclave Sessions";
var DOMAIN_VERSION = "2";
var BASE_CHAIN_ID = 8453n;
var SUPPORTED_CHAIN_IDS = Object.freeze([BASE_CHAIN_ID]);
var ACTION_GAS_FUND = 10;
var RETIRED_ACTION = 9;
var INTENT_BYTES = 224;
var MAX_DEADLINE_WINDOW = 900n;
var UNISWAP_V3_FEE_TIERS = Object.freeze([100, 500, 3e3, 1e4]);
var ENV_STAGING = 1;
var ENV_PROD = 2;
var MAX_GRANT_APPS = 8;
var ZERO_HASH = `0x${"0".repeat(64)}`;
var ZERO_ADDRESS = `0x${"0".repeat(40)}`;
var UINT_MAX = Object.freeze({
  8: max(8),
  24: max(24),
  32: max(32),
  64: max(64),
  96: max(96),
  128: max(128),
  192: max(192),
  256: max(256)
});
var ACTIONS_V2 = Object.freeze({
  "deploy.create": 0,
  "deploy.fund": 1,
  "deploy.setAppRef": 2,
  "deploy.setConfig": 3,
  "deploy.setShares": 4,
  "deploy.setMaxRate": 5,
  "deploy.setActive": 6,
  "deploy.refund": 7,
  "app.publish": 8,
  "gas.fund": 10,
  "api.status": 128,
  "api.logs": 129,
  "api.restart": 130,
  "api.upload": 131,
  "api.appAccess": 132,
  "api.placement": 133,
  "api.account": 134
});
var RETIRED_ACTION_NAMES = Object.freeze(["order.pay"]);
var ENVIRONMENTS = Object.freeze({ staging: ENV_STAGING, prod: ENV_PROD });
var TYPES_V2 = deepFreeze({
  SessionGrant: [
    { name: "label", type: "string" },
    { name: "preset", type: "string" },
    { name: "sessionKey", type: "bytes32" },
    { name: "actions", type: "string[]" },
    { name: "apps", type: "string[]" },
    { name: "environments", type: "string[]" },
    { name: "budget", type: "uint256" },
    { name: "spendPerPeriod", type: "uint256" },
    { name: "periodSeconds", type: "uint32" },
    { name: "opsPerPeriod", type: "uint32" },
    { name: "maxFeePerOp", type: "uint256" },
    { name: "maxAppFeePerHour", type: "uint256" },
    { name: "maxRatePerHour", type: "uint256" },
    { name: "maxGasUsdcPerOp", type: "uint256" },
    { name: "maxUsdcPerEth6", type: "uint256" },
    { name: "maxEthPerOp", type: "uint256" },
    { name: "expiresAt", type: "uint64" },
    { name: "measurement", type: "bytes32" },
    { name: "grantNonce", type: "bytes32" },
    { name: "signBefore", type: "uint64" }
  ],
  SessionCall: [
    { name: "sessionId", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "action", type: "uint8" },
    { name: "argsHash", type: "bytes32" },
    { name: "fee", type: "uint256" },
    { name: "deadline", type: "uint64" }
  ],
  SessionEnd: [
    { name: "sessionId", type: "bytes32" },
    { name: "deadline", type: "uint64" }
  ],
  TopUp: [
    { name: "sessionId", type: "bytes32" },
    { name: "amount", type: "uint256" },
    { name: "opNonce", type: "bytes32" },
    { name: "signBefore", type: "uint64" }
  ],
  Extend: [
    { name: "sessionId", type: "bytes32" },
    { name: "expiresAt", type: "uint64" },
    { name: "opNonce", type: "bytes32" },
    { name: "signBefore", type: "uint64" }
  ],
  Terminate: [
    { name: "sessionId", type: "bytes32" },
    { name: "opNonce", type: "bytes32" },
    { name: "signBefore", type: "uint64" }
  ],
  RevokeAll: [
    { name: "withdraw", type: "bool" },
    { name: "opNonce", type: "bytes32" },
    { name: "signBefore", type: "uint64" }
  ],
  Withdraw: [
    { name: "amount", type: "uint256" },
    { name: "opNonce", type: "bytes32" },
    { name: "signBefore", type: "uint64" }
  ],
  Promote: [
    { name: "deployment", type: "bytes32" },
    { name: "app", type: "string" },
    { name: "publisher", type: "address" },
    { name: "appRef", type: "string" },
    { name: "configCid", type: "string" },
    { name: "versionLabel", type: "string" },
    { name: "isPublic", type: "bool" },
    { name: "opNonce", type: "bytes32" },
    { name: "signBefore", type: "uint64" }
  ],
  Adopt: [
    { name: "deployment", type: "bytes32" },
    { name: "environment", type: "string" },
    { name: "opNonce", type: "bytes32" },
    { name: "signBefore", type: "uint64" }
  ],
  SetEnvironment: [
    { name: "deployment", type: "bytes32" },
    { name: "environment", type: "string" },
    { name: "opNonce", type: "bytes32" },
    { name: "signBefore", type: "uint64" }
  ],
  Release: [
    { name: "deployment", type: "bytes32" },
    { name: "to", type: "address" },
    { name: "opNonce", type: "bytes32" },
    { name: "signBefore", type: "uint64" }
  ]
});
var OWNER_OPS = Object.freeze({
  topUp: "TopUp",
  extend: "Extend",
  terminate: "Terminate",
  revokeAll: "RevokeAll",
  withdraw: "Withdraw",
  promote: "Promote",
  adopt: "Adopt",
  setEnvironment: "SetEnvironment",
  release: "Release"
});
var GAS_LIMIT_FIELDS = Object.freeze(["maxGasUsdcPerOp", "maxUsdcPerEth6", "maxEthPerOp"]);
var INTENT_FIELDS = Object.freeze(
  ["payer", "deployment", "expectedOwner", "ethOut", "maxUsdcIn6", "fee", "deadline"]
);
var INTENT_PARAMS = Object.freeze([
  { type: "address" },
  { type: "bytes32" },
  { type: "address" },
  { type: "uint256" },
  { type: "uint256" },
  { type: "uint24" },
  { type: "uint64" }
]);
function parseUint(v, bits, name) {
  let n;
  if (typeof v === "bigint") n = v;
  else if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) fail2("uint_unsafe_number", `${name} must be a safe integer, bigint or decimal string`, { name });
    n = BigInt(v);
  } else if (typeof v === "string") {
    if (v.startsWith("-")) fail2("uint_negative", `${name} is negative`, { name });
    if (/^0[xXbBoO]/.test(v)) fail2("uint_hex_ambiguous", `${name}: prefixed strings are refused; use decimal or bigint`, { name });
    if (!/^(0|[1-9][0-9]*)$/.test(v)) fail2("uint_format", `${name} is not a canonical decimal string`, { name });
    n = BigInt(v);
  } else fail2("uint_type", `${name} is missing or not an integer`, { name });
  if (n < 0n) fail2("uint_negative", `${name} is negative`, { name });
  if (n > max(bits)) fail2("uint_overflow", `${name} exceeds uint${bits}`, { name, bits });
  return n;
}
function parseAddress(v, name, { allowZero = false } = {}) {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(v)) fail2("address_format", `${name} is not a 20-byte hex address`, { name });
  const c = getAddress(v.toLowerCase());
  const body = v.slice(2);
  if (body !== body.toLowerCase() && v !== c) fail2("address_checksum", `${name} has a wrong EIP-55 checksum`, { name });
  if (!allowZero && c === ZERO_ADDRESS) fail2("address_zero", `${name} is the zero address`, { name });
  return c;
}
function parseHex32(v, name, { nonZero = false } = {}) {
  if (typeof v !== "string" || !/^0x[0-9a-f]{64}$/.test(v)) fail2("hex32_format", `${name} is not lowercase 0x + 64 hex`, { name });
  if (nonZero && v === ZERO_HASH) fail2("hex32_zero", `${name} is zero`, { name });
  return v;
}
function parseHexBytes(v, name) {
  if (typeof v !== "string" || !/^0x(?:[0-9a-f]{2})*$/.test(v)) fail2("hex_format", `${name} is not lowercase even-length hex`, { name });
  return v;
}
function parseBool(v, name) {
  if (typeof v !== "boolean") fail2("bool_type", `${name} must be a boolean`, { name });
  return v;
}
function parseString(v, name) {
  if (typeof v !== "string") fail2("string_type", `${name} must be a string`, { name });
  return v;
}
function plainObject(o, name) {
  if (o === null || typeof o !== "object" || Array.isArray(o)) fail2("object_type", `${name} must be an object`, { name });
  const p = Object.getPrototypeOf(o);
  if (p !== Object.prototype && p !== null) fail2("object_type", `${name} must be a plain object`, { name });
}
function exactKeys(o, required, optional, name) {
  plainObject(o, name);
  const allowed = /* @__PURE__ */ new Set([...required, ...optional]);
  const extra = Object.keys(o).filter((k) => !allowed.has(k));
  if (extra.length) fail2("unknown_field", `${name} has unknown field(s) ${extra.join(", ")}`, { name, extra });
  const missing = required.filter((k) => !has(o, k) || o[k] === void 0);
  if (missing.length) fail2("missing_field", `${name} is missing ${missing.join(", ")}`, { name, missing });
}
function parseField(type, v, name) {
  if (type === "bytes32") return parseHex32(v, name);
  if (type === "address") return parseAddress(v, name);
  if (type === "bool") return parseBool(v, name);
  if (type === "string") return parseString(v, name);
  if (type === "string[]") {
    if (!Array.isArray(v)) fail2("array_type", `${name} must be an array of strings`, { name });
    return v.map((s, k) => parseString(s, `${name}[${k}]`));
  }
  const m = /^uint(\d+)$/.exec(type);
  if (m) return parseUint(v, Number(m[1]), name);
  return fail2("internal", `unhandled type ${type}`);
}
function parseMessage(primaryType, input, name) {
  const fields = TYPES_V2[primaryType];
  exactKeys(input, fields.map((f) => f.name), [], name);
  const out = {};
  for (const f of fields) out[f.name] = parseField(f.type, input[f.name], `${name}.${f.name}`);
  return out;
}
function requireDomainVersion(input, name) {
  plainObject(input, name);
  if (!has(input, "domainVersion")) fail2("domain_version_required", `${name} must state domainVersion "2" explicitly`);
  if (input.domainVersion !== DOMAIN_VERSION) {
    fail2(
      "domain_version_unsupported",
      `${name}.domainVersion must be the string "2" (version 1 belongs to the original SDK)`,
      { got: input.domainVersion }
    );
  }
}
function splitNonce(v, name = "nonce") {
  const nonce = parseUint(v, 256, name);
  const lane = nonce >> 64n;
  const seq = nonce & UINT_MAX[64];
  if (seq === UINT_MAX[64]) fail2("nonce_wrap", `${name}: lane ${lane} is at its last sequence; it cannot advance`, { lane });
  return Object.freeze({ nonce, lane, seq, nextSeq: seq + 1n });
}
var CLONE_PREFIX = "3d602d80600a3d3981f3363d3d373d3d3d363d73";
var CLONE_SUFFIX = "5af43d82803e903d91602b57fd5bf3";
function predictVault(factory, implementation, owner) {
  const f = parseAddress(factory, "factory").slice(2).toLowerCase();
  const i = parseAddress(implementation, "implementation").slice(2).toLowerCase();
  const o = parseAddress(owner, "owner").slice(2).toLowerCase();
  const codeHash = keccak256(`0x${CLONE_PREFIX}${i}${CLONE_SUFFIX}`).slice(2);
  const h = keccak256(`0xff${f}${o.padStart(64, "0")}${codeHash}`);
  return getAddress(`0x${h.slice(26)}`);
}
var TRUSTED = /* @__PURE__ */ new WeakSet();
function fundingConfig(c) {
  exactKeys(c, [
    "chainId",
    "factory",
    "implementation",
    "vault",
    "owner",
    "gasAdapter",
    "legacyFactory",
    "adapterMaxEthOut",
    "adapterFeeTiers"
  ], ["legacyVault"], "config");
  const chainId = parseUint(c.chainId, 256, "config.chainId");
  if (!SUPPORTED_CHAIN_IDS.includes(chainId)) fail2("chain_unsupported", `chain ${chainId} is not configured (Base 8453 only)`, { chainId });
  const cfg = {
    chainId,
    factory: parseAddress(c.factory, "config.factory"),
    implementation: parseAddress(c.implementation, "config.implementation"),
    vault: parseAddress(c.vault, "config.vault"),
    owner: parseAddress(c.owner, "config.owner"),
    gasAdapter: parseAddress(c.gasAdapter, "config.gasAdapter"),
    legacyFactory: parseAddress(c.legacyFactory, "config.legacyFactory"),
    legacyVault: c.legacyVault === void 0 || c.legacyVault === null ? null : parseAddress(c.legacyVault, "config.legacyVault"),
    adapterMaxEthOut: parseUint(c.adapterMaxEthOut, 96, "config.adapterMaxEthOut"),
    adapterFeeTiers: null
  };
  const ids = ["factory", "implementation", "vault", "owner", "gasAdapter", "legacyFactory", "legacyVault"].filter((k) => cfg[k] !== null).map((k) => cfg[k]);
  if (new Set(ids).size !== ids.length) fail2("config_identity_collision", "config identities must be pairwise distinct");
  const expect = predictVault(cfg.factory, cfg.implementation, cfg.owner);
  if (cfg.vault !== expect) fail2("vault_mismatch", `config.vault is not factory.vaultFor(owner) (${expect})`, { expect });
  if (cfg.adapterMaxEthOut === 0n) fail2("config_adapter_max_zero", "config.adapterMaxEthOut must be positive");
  if (!Array.isArray(c.adapterFeeTiers) || c.adapterFeeTiers.length === 0) fail2("config_fee_tiers", "config.adapterFeeTiers must be a non-empty array");
  const tiers = c.adapterFeeTiers.map((t, k) => Number(parseUint(t, 24, `config.adapterFeeTiers[${k}]`)));
  if (tiers.some((t) => !UNISWAP_V3_FEE_TIERS.includes(t)) || new Set(tiers).size !== tiers.length) {
    fail2("config_fee_tiers", "config.adapterFeeTiers must be distinct members of 100/500/3000/10000");
  }
  cfg.adapterFeeTiers = tiers;
  deepFreeze(cfg);
  TRUSTED.add(cfg);
  return cfg;
}
function trusted(cfg) {
  if (!TRUSTED.has(cfg)) fail2("config_untrusted", "pass the object returned by fundingConfig(), not a copy or a quote");
}
function checkEcho(cfg, input, name) {
  if (has(input, "chainId") && parseUint(input.chainId, 256, `${name}.chainId`) !== cfg.chainId) {
    fail2("chain_mismatch", `${name}.chainId differs from the configured chain ${cfg.chainId}`);
  }
  if (has(input, "vault") && parseAddress(input.vault, `${name}.vault`) !== cfg.vault) {
    fail2("vault_mismatch", `${name}.vault differs from the configured vault ${cfg.vault}`);
  }
}
function domainOf(cfg) {
  trusted(cfg);
  return Object.freeze({ name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId: Number(cfg.chainId), verifyingContract: cfg.vault });
}
function typed(cfg, primaryType, message) {
  const td = deepFreeze({ domain: domainOf(cfg), types: { [primaryType]: TYPES_V2[primaryType] }, primaryType, message });
  return { typedData: td, digest: hashTypedData(td) };
}
function sessionIdOf(vault, sessionKey, grantNonce) {
  return keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "bytes32" }, { type: "bytes32" }],
    [parseAddress(vault, "vault"), parseHex32(sessionKey, "sessionKey"), parseHex32(grantNonce, "grantNonce")]
  ));
}
function keyHashOf(x, y) {
  return keccak256(encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }],
    [parseUint(x, 256, "x"), parseUint(y, 256, "y")]
  ));
}
function buildGrantV2(cfg, input) {
  trusted(cfg);
  requireDomainVersion(input, "grantInput");
  exactKeys(input, ["domainVersion", "now", "grant"], ["chainId", "vault"], "grantInput");
  checkEcho(cfg, input, "grantInput");
  const now = parseUint(input.now, 64, "grantInput.now");
  plainObject(input.grant, "grant");
  const missingGas = GAS_LIMIT_FIELDS.filter((k) => !has(input.grant, k) || input.grant[k] === void 0);
  if (missingGas.length) {
    fail2(
      "grant_missing_gas_limits",
      `grant lacks ${missingGas.join(", ")}: a version-1 grant is never reused as version 2`,
      { missing: missingGas }
    );
  }
  const g = parseMessage("SessionGrant", input.grant, "grant");
  if (g.sessionKey === ZERO_HASH) fail2("grant_session_key_zero", "grant.sessionKey is zero");
  if (g.grantNonce === ZERO_HASH) fail2("grant_nonce_zero", "grant.grantNonce is zero");
  let actions = 0n;
  const seen = /* @__PURE__ */ new Set();
  for (const a of g.actions) {
    if (RETIRED_ACTION_NAMES.includes(a)) fail2("retired_action", `${a} is retired (action 9)`);
    if (!has(ACTIONS_V2, a)) fail2("unknown_action", `unknown action ${a}`);
    if (seen.has(a)) fail2("duplicate_action", `duplicate action ${a}`);
    seen.add(a);
    actions |= 1n << BigInt(ACTIONS_V2[a]);
  }
  if (g.apps.length > MAX_GRANT_APPS) fail2("grant_too_many_apps", `at most ${MAX_GRANT_APPS} apps`);
  if (g.apps.some((a) => a.length === 0) || new Set(g.apps).size !== g.apps.length) fail2("grant_apps", "apps must be distinct non-empty strings");
  let envs = 0;
  for (const e of g.environments) {
    if (!has(ENVIRONMENTS, e)) fail2("unknown_environment", `unknown environment ${e}`);
    envs |= ENVIRONMENTS[e];
  }
  if (new Set(g.environments).size !== g.environments.length) fail2("duplicate_environment", "duplicate environment");
  if (g.periodSeconds === 0n) fail2("grant_period_zero", "periodSeconds must be positive");
  for (const k of ["budget", "spendPerPeriod", "maxFeePerOp", "maxAppFeePerHour", "maxRatePerHour"]) {
    if (g[k] > UINT_MAX[128]) fail2("uint_overflow", `grant.${k} exceeds uint128 (the vault refuses it)`, { name: k, bits: 128 });
  }
  const gas = actions >> BigInt(ACTION_GAS_FUND) & 1n;
  if (gas === 1n) {
    for (const k of GAS_LIMIT_FIELDS) if (g[k] === 0n) fail2("grant_gas_limit_zero", `gas.fund granted but ${k} is 0`, { name: k });
    if (g.maxGasUsdcPerOp > UINT_MAX[128]) fail2("uint_overflow", "grant.maxGasUsdcPerOp exceeds uint128", { bits: 128 });
    if (g.maxUsdcPerEth6 > UINT_MAX[128]) fail2("uint_overflow", "grant.maxUsdcPerEth6 exceeds uint128", { bits: 128 });
    if (g.maxEthPerOp > UINT_MAX[96]) fail2("uint_overflow", "grant.maxEthPerOp exceeds uint96", { bits: 96 });
  } else if (GAS_LIMIT_FIELDS.some((k) => g[k] !== 0n)) {
    fail2("grant_gas_limits_without_action", "gas limits must all be 0 unless gas.fund is granted");
  }
  if (g.expiresAt <= now) fail2("grant_expired", "grant.expiresAt must be after now");
  if (g.signBefore < now) fail2("grant_sign_window_passed", "grant.signBefore is before now");
  const out = typed(cfg, "SessionGrant", g);
  return deepFreeze({
    ...out,
    sessionId: sessionIdOf(cfg.vault, g.sessionKey, g.grantNonce),
    actionsMask: actions,
    envsMask: envs,
    gasFundGranted: gas === 1n,
    gasLimits: { maxGasUsdcPerOp: g.maxGasUsdcPerOp, maxUsdcPerEth6: g.maxUsdcPerEth6, maxEthPerOp: g.maxEthPerOp }
  });
}
function parseIntent(i, name) {
  exactKeys(i, INTENT_FIELDS, [], name);
  const fee = Number(parseUint(i.fee, 24, `${name}.fee`));
  if (!UNISWAP_V3_FEE_TIERS.includes(fee)) fail2("fee_tier", `${name}.fee ${fee} is not a Uniswap V3 tier`);
  const out = {
    payer: parseAddress(i.payer, `${name}.payer`),
    deployment: parseHex32(i.deployment, `${name}.deployment`, { nonZero: true }),
    expectedOwner: parseAddress(i.expectedOwner, `${name}.expectedOwner`),
    ethOut: parseUint(i.ethOut, 256, `${name}.ethOut`),
    maxUsdcIn6: parseUint(i.maxUsdcIn6, 256, `${name}.maxUsdcIn6`),
    fee,
    deadline: parseUint(i.deadline, 64, `${name}.deadline`)
  };
  if (out.ethOut === 0n) fail2("eth_out_zero", "ethOut (exact output) must be positive");
  if (out.maxUsdcIn6 === 0n) fail2("max_usdc_zero", "maxUsdcIn6 must be positive");
  return deepFreeze(out);
}
function encodeDexGasIntent(intent) {
  const i = parseIntent(intent, "intent");
  return encodeAbiParameters(
    INTENT_PARAMS,
    [i.payer, i.deployment, i.expectedOwner, i.ethOut, i.maxUsdcIn6, BigInt(i.fee), i.deadline]
  );
}
function decodeDexGasIntent(data) {
  const hex = parseHexBytes(data, "intent data");
  const bytes = (hex.length - 2) / 2;
  if (bytes !== INTENT_BYTES) fail2("intent_length", `intent is ${bytes} bytes, must be exactly ${INTENT_BYTES}`, { bytes });
  const [payer, deployment, expectedOwner, ethOut, maxUsdcIn6, fee, deadline] = decodeAbiParameters(INTENT_PARAMS, hex);
  const i = parseIntent(
    { payer, deployment, expectedOwner, ethOut, maxUsdcIn6, fee: Number(fee), deadline: BigInt(deadline) },
    "intent"
  );
  if (encodeDexGasIntent(i) !== hex) fail2("intent_noncanonical", "intent words carry non-canonical (dirty) bits");
  return i;
}
var CALL_KEYS = ["domainVersion", "now", "sessionId", "nonce", "action", "intent", "fee", "deadline"];
function checkDeadlines(now, callDeadline, intentDeadline) {
  if (callDeadline < now) fail2("call_deadline_passed", "call deadline is before now");
  if (intentDeadline < now) fail2("intent_deadline_passed", "intent deadline is before now");
  if (intentDeadline > now + MAX_DEADLINE_WINDOW) fail2("intent_deadline_too_far", `intent deadline is more than ${MAX_DEADLINE_WINDOW}s ahead`);
  if (callDeadline > intentDeadline) fail2("call_outlives_intent", "call deadline is after the intent deadline");
}
function buildGasFundCall(cfg, input) {
  trusted(cfg);
  requireDomainVersion(input, "call");
  exactKeys(input, CALL_KEYS, ["chainId", "vault"], "call");
  checkEcho(cfg, input, "call");
  const now = parseUint(input.now, 64, "call.now");
  const action = Number(parseUint(input.action, 8, "call.action"));
  if (action === RETIRED_ACTION) fail2("retired_action", "action 9 is retired");
  if (action !== ACTION_GAS_FUND) fail2("action_not_gas", `this codec builds action 10 only (got ${action})`);
  const sessionId = parseHex32(input.sessionId, "call.sessionId", { nonZero: true });
  const n = splitNonce(input.nonce, "call.nonce");
  const fee = parseUint(input.fee, 256, "call.fee");
  if (fee > UINT_MAX[128]) fail2("uint_overflow", "call.fee exceeds any uint128 maxFeePerOp", { bits: 128 });
  const deadline = parseUint(input.deadline, 64, "call.deadline");
  const intent = parseIntent(input.intent, "intent");
  if (intent.payer !== cfg.vault) fail2("payer_not_vault", "intent.payer must be exactly the configured vault");
  const holders = [cfg.vault, cfg.owner, cfg.legacyVault].filter(Boolean);
  if (!holders.includes(intent.expectedOwner)) fail2("holder_not_allowed", "intent.expectedOwner is not the vault, owner or configured legacy vault");
  if (!cfg.adapterFeeTiers.includes(intent.fee)) fail2("fee_tier_not_configured", `pool tier ${intent.fee} is not in config.adapterFeeTiers`);
  if (intent.ethOut > cfg.adapterMaxEthOut) fail2("adapter_eth_cap", "ethOut exceeds the adapter's maxEthOut");
  if (intent.maxUsdcIn6 > UINT_MAX[128]) fail2("uint_overflow", "maxUsdcIn6 exceeds any uint128 session limit", { bits: 128 });
  checkDeadlines(now, deadline, intent.deadline);
  const args = encodeDexGasIntent(intent);
  const argsHash = keccak256(args);
  const message = { sessionId, nonce: n.nonce, action: BigInt(ACTION_GAS_FUND), argsHash, fee, deadline };
  return deepFreeze({
    ...typed(cfg, "SessionCall", message),
    args,
    argsHash,
    intent,
    nonce: { value: n.nonce, lane: n.lane, seq: n.seq, nextSeq: n.nextSeq },
    // what vault.execute takes besides the P-256 (x, y, r, s) the session signer adds
    execute: { sessionId, nonce: n.nonce, action: ACTION_GAS_FUND, args, fee, deadline },
    maximum: { maxUsdcIn6: intent.maxUsdcIn6, fee6: fee, totalMaximum6: intent.maxUsdcIn6 + fee }
  });
}
var GAS_FUNDED_EVENT = deepFreeze({
  type: "event",
  name: "GasFunded",
  inputs: [
    { name: "sid", type: "bytes32", indexed: true },
    { name: "deployment", type: "bytes32", indexed: true },
    { name: "holder", type: "address", indexed: true },
    { name: "ethOut", type: "uint256", indexed: false },
    { name: "usdcSpent6", type: "uint256", indexed: false },
    { name: "maxUsdcIn6", type: "uint256", indexed: false },
    { name: "relayer", type: "address", indexed: false },
    { name: "fee6", type: "uint256", indexed: false }
  ]
});
var SESSION_OP_EVENT = deepFreeze({
  type: "event",
  name: "SessionOp",
  inputs: [
    { name: "sid", type: "bytes32", indexed: true },
    { name: "nonce", type: "uint256", indexed: false },
    { name: "action", type: "uint8", indexed: true },
    { name: "argsHash", type: "bytes32", indexed: false },
    { name: "amount6", type: "uint256", indexed: false },
    { name: "fee6", type: "uint256", indexed: false },
    { name: "result", type: "bytes", indexed: false }
  ]
});
var SETTLEMENT_ABI = Object.freeze([GAS_FUNDED_EVENT, SESSION_OP_EVENT]);
var GAS_FUNDED_DATA = Object.freeze(GAS_FUNDED_EVENT.inputs.filter((p) => !p.indexed).map((p) => ({ type: p.type })));
var SESSION_OP_DATA = Object.freeze(SESSION_OP_EVENT.inputs.filter((p) => !p.indexed).map((p) => ({ type: p.type })));
var GAS_FUNDED_TOPIC = hashString("GasFunded(bytes32,bytes32,address,uint256,uint256,uint256,address,uint256)");
var SESSION_OP_TOPIC = hashString("SessionOp(bytes32,uint256,uint8,bytes32,uint256,uint256,bytes)");
var topicWord = (hexBody) => `0x${hexBody.toLowerCase().padStart(64, "0")}`;
function canonicalLog(ev, topics, data, k) {
  const a = ev.args;
  let enc;
  let indexedOk;
  if (ev.eventName === "GasFunded") {
    enc = encodeAbiParameters(GAS_FUNDED_DATA, [a.ethOut, a.usdcSpent6, a.maxUsdcIn6, a.relayer, a.fee6]);
    indexedOk = topics[3] === topicWord(a.holder.slice(2));
  } else {
    enc = encodeAbiParameters(SESSION_OP_DATA, [a.nonce, a.argsHash, a.amount6, a.fee6, a.result]);
    indexedOk = topics[2] === topicWord(BigInt(a.action).toString(16));
  }
  if (enc !== data || !indexedOk) fail2("log_noncanonical", `logs[${k}] is not the canonical encoding of ${ev.eventName}`);
}
function parseGasSettlement(cfg, input) {
  trusted(cfg);
  exactKeys(input, ["call", "logs", "sessionOpAmountSemantics"], ["submitter", "balances"], "settlement");
  const sem = input.sessionOpAmountSemantics;
  if (sem !== "actual") fail2("amount_semantics_required", 'sessionOpAmountSemantics must be "actual"');
  exactKeys(input.call, ["sessionId", "nonce", "args", "fee"], [], "settlement.call");
  const sid = parseHex32(input.call.sessionId, "call.sessionId", { nonZero: true });
  const nonce = parseUint(input.call.nonce, 256, "call.nonce");
  const args = parseHexBytes(input.call.args, "call.args");
  const intent = decodeDexGasIntent(args);
  if (intent.payer !== cfg.vault) fail2("payer_mismatch", "settlement payer is not the configured vault");
  if (![cfg.vault, cfg.owner, cfg.legacyVault].filter(Boolean).includes(intent.expectedOwner)) fail2("holder_not_allowed", "settlement holder is not in configured scope");
  const fee = parseUint(input.call.fee, 256, "call.fee");
  if (!Array.isArray(input.logs)) fail2("logs_type", "logs must be an array");
  const ops = [];
  const funded = [];
  input.logs.forEach((log, k) => {
    if (log === null || typeof log !== "object") fail2("log_format", `logs[${k}] is not an object`);
    if (parseAddress(log.address, `logs[${k}].address`, { allowZero: true }) !== cfg.vault) return;
    if (!Array.isArray(log.topics) || log.topics.length === 0) return;
    const topics = log.topics.map((t, j) => parseHex32(t, `logs[${k}].topics[${j}]`));
    if (topics[0] !== GAS_FUNDED_TOPIC && topics[0] !== SESSION_OP_TOPIC) return;
    const data = parseHexBytes(log.data, `logs[${k}].data`);
    let ev;
    try {
      ev = decodeEventLog({ abi: SETTLEMENT_ABI, topics, data, strict: true });
    } catch (e) {
      fail2("log_decode", `logs[${k}] does not decode: ${e.shortMessage ?? e.message}`);
    }
    canonicalLog(ev, topics, data, k);
    if (ev.args.sid !== sid) return;
    if (ev.eventName === "GasFunded") funded.push(ev.args);
    else if (ev.args.nonce === nonce) ops.push(ev.args);
  });
  if (ops.length !== 1) fail2("session_op_count", `expected one SessionOp for this sid/nonce, found ${ops.length}`);
  if (funded.length !== 1) fail2("gas_funded_count", `expected one GasFunded for this sid, found ${funded.length}`);
  const op = ops[0];
  const gf = funded[0];
  if (Number(op.action) !== ACTION_GAS_FUND) fail2("settlement_action", "SessionOp is not action 10");
  if (op.argsHash !== keccak256(args)) fail2("settlement_args", "SessionOp.argsHash differs from the signed args");
  if (op.fee6 !== fee || gf.fee6 !== fee) fail2("fee_mismatch", "signed fee, SessionOp.fee6 and GasFunded.fee6 must be equal");
  if (gf.deployment !== intent.deployment || gf.holder !== intent.expectedOwner) fail2("settlement_scope", "GasFunded deployment/holder differ from the intent");
  if (gf.ethOut !== intent.ethOut) fail2("settlement_eth", "GasFunded.ethOut differs from the exact signed output");
  if (gf.maxUsdcIn6 !== intent.maxUsdcIn6) fail2("settlement_max", "GasFunded.maxUsdcIn6 differs from the signed maximum");
  const used = gf.usdcSpent6;
  if (used === 0n) fail2("actual_zero", "the adapter reported zero USDC spent");
  if (used > intent.maxUsdcIn6) fail2("actual_exceeds_max", `actual ${used} exceeds signed maximum ${intent.maxUsdcIn6}`);
  if (typeof op.result !== "string" || op.result.length !== 2 + 128) fail2("settlement_result", "SessionOp.result must be abi.encode(used, refund)");
  const [resUsed, refund] = decodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], op.result);
  if (resUsed !== used) fail2("settlement_result", "SessionOp.result used differs from GasFunded.usdcSpent6");
  if (used + refund !== intent.maxUsdcIn6) fail2("refund_mismatch", "actual + refund must equal the signed maximum");
  const expectAmount = used;
  if (op.amount6 !== expectAmount) {
    fail2("amount_semantics_mismatch", `SessionOp.amount6 ${op.amount6} does not match "${sem}" semantics (${expectAmount})`);
  }
  let relayerMatchesSubmitter = null;
  if (has(input, "submitter")) {
    if (gf.relayer !== parseAddress(input.submitter, "submitter")) fail2("relayer_mismatch", "GasFunded.relayer is not the submitter");
    relayerMatchesSubmitter = true;
  }
  const totalDebit6 = used + fee;
  if (has(input, "balances")) {
    const b = input.balances;
    exactKeys(b, ["balance6Before", "balance6After"], [], "settlement.balances");
    const before = parseUint(b.balance6Before, 128, "balance6Before");
    const after = parseUint(b.balance6After, 128, "balance6After");
    if (after > before || before - after !== totalDebit6) fail2("session_balance_mismatch", "session balance change is not actual + fee");
  }
  return deepFreeze({
    chainAuthenticated: false,
    sessionId: sid,
    nonce,
    deployment: intent.deployment,
    holder: gf.holder,
    ethOut: gf.ethOut,
    relayer: gf.relayer,
    relayerMatchesSubmitter,
    maximum: { maxUsdcIn6: intent.maxUsdcIn6, fee6: fee, totalMaximum6: intent.maxUsdcIn6 + fee },
    actual: { usdcSpent6: used, fee6: fee, totalDebit6 },
    refund6: refund,
    sessionOpAmount6: op.amount6,
    sessionOpAmountSemantics: sem
  });
}

// sdk/funding/v2-store.mjs
var V2_DB = "enclave-funding-v2";
var V2_DB_VERSION = 1;
var KEYS = "gas-keys";
var JOURNAL = "journal";
var RECORD_KIND = "enclave-funding-gas-session";
var RECORD_VERSION = 2;
var LEGACY_DB = "enclave-sessions";
var ALG = { name: "ECDSA", namedCurve: "P-256" };
var SIGN = { name: "ECDSA", hash: "SHA-256" };
function subtleOf(subtle) {
  const s = subtle ?? globalThis.crypto?.subtle;
  if (!s) fail("webcrypto_missing", "WebCrypto is not available");
  return s;
}
async function newGasKey(subtle) {
  const s = subtleOf(subtle);
  const kp = await s.generateKey(ALG, false, ["sign", "verify"]);
  if (!kp?.privateKey || kp.privateKey.extractable !== false) fail("key_extractable", "the session key must be non-extractable");
  const raw = new Uint8Array(await s.exportKey("raw", kp.publicKey));
  if (raw.length !== 65 || raw[0] !== 4) fail("key_encoding", "unexpected P-256 public key encoding");
  const x = BigInt(bytesToHex(raw.slice(1, 33)));
  const y = BigInt(bytesToHex(raw.slice(33, 65)));
  return Object.freeze({ privateKey: kp.privateKey, x, y, keyHash: keyHashOf(x, y) });
}
function signerFor(privateKey, x, y, subtle) {
  const s = subtleOf(subtle);
  if (!privateKey || privateKey.extractable !== false) fail("key_extractable", "refusing to sign with an extractable key");
  const keyHash = keyHashOf(x, y);
  return Object.freeze({
    x: BigInt(x),
    y: BigInt(y),
    keyHash,
    async signDigest(digest) {
      if (typeof digest !== "string" || !/^0x[0-9a-f]{64}$/.test(digest)) fail("digest_format", "digest must be lowercase 0x + 64 hex");
      const sig = new Uint8Array(await s.sign(SIGN, privateKey, hexToBytes(digest)));
      if (sig.length !== 64) fail("signature_format", "expected a 64-byte P1363 signature");
      return { r: bytesToHex(sig.slice(0, 32)), s: bytesToHex(sig.slice(32, 64)) };
    }
  });
}
var gasRecordId = (keyHash) => `gas-${keyHash.slice(2)}`;
function newGasRecord({ key, chainId, relay, owner, vault, factory, implementation, label, now }) {
  return {
    v: RECORD_VERSION,
    kind: RECORD_KIND,
    domainVersion: DOMAIN_VERSION,
    id: gasRecordId(key.keyHash),
    status: "new",
    chainId: Number(chainId),
    relay: String(relay),
    owner,
    vault,
    factory,
    implementation,
    label: String(label),
    x: key.x.toString(),
    y: key.y.toString(),
    keyHash: key.keyHash,
    privateKey: key.privateKey,
    grant: null,
    grantDigest: null,
    sid: null,
    open: null,
    createdAt: Number(now)
  };
}
function validateGasRecord(rec) {
  if (!rec || typeof rec !== "object") fail("record_type", "record must be an object");
  if (rec.v !== RECORD_VERSION || rec.kind !== RECORD_KIND || rec.domainVersion !== DOMAIN_VERSION) {
    fail("record_version", "not a version-2 successor gas record");
  }
  if ("handle" in rec) fail("record_shape", "a successor record must not carry a v1 `handle`");
  if ("pkcs8" in rec) fail("record_secret", "successor records never hold exportable key bytes");
  if (!rec.privateKey || rec.privateKey.extractable !== false) fail("key_extractable", "successor keys must be non-extractable CryptoKeys");
  if (keyHashOf(BigInt(rec.x), BigInt(rec.y)) !== rec.keyHash) fail("key_hash_mismatch", "stored public key does not match its key hash");
  if (rec.id !== gasRecordId(rec.keyHash)) fail("record_id", "record id is not derived from its key hash");
  if (rec.grant !== null) canon(rec.grant);
  return rec;
}
var checkJournal = (e) => {
  assertPublic(e);
  canon(e);
  return e;
};
var IndexedDbV2Store = class {
  constructor(name = V2_DB, idb = globalThis.indexedDB) {
    if (!idb) fail("indexeddb_missing", "IndexedDB is not available");
    if (name === LEGACY_DB) fail("store_collision", "the successor store must not share the SDK's database");
    this.name = name;
    this.idb = idb;
  }
  _db() {
    return new Promise((ok, bad) => {
      const r = this.idb.open(this.name, V2_DB_VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains(KEYS)) db.createObjectStore(KEYS, { keyPath: "id" });
        if (!db.objectStoreNames.contains(JOURNAL)) db.createObjectStore(JOURNAL, { keyPath: "id" });
      };
      r.onsuccess = () => ok(r.result);
      r.onerror = () => bad(r.error);
    });
  }
  async _tx(store, mode, f) {
    const db = await this._db();
    return new Promise((ok, bad) => {
      const t = db.transaction(store, mode);
      const req = f(t.objectStore(store));
      t.oncomplete = () => {
        db.close();
        ok(req.result);
      };
      t.onerror = () => {
        db.close();
        bad(t.error);
      };
      t.onabort = () => {
        db.close();
        bad(t.error ?? new Error("transaction aborted"));
      };
    });
  }
  async saveKey(rec) {
    validateGasRecord(rec);
    const prior = await this.loadKey(rec.id);
    if (prior && prior.keyHash !== rec.keyHash) fail("record_key_changed", "a record id never changes its key");
    await this._tx(KEYS, "readwrite", (s) => s.put(rec));
  }
  async loadKey(id) {
    return await this._tx(KEYS, "readonly", (s) => s.get(id)) ?? null;
  }
  async listKeys() {
    return this._tx(KEYS, "readonly", (s) => s.getAll());
  }
  async putJournal(e) {
    checkJournal(e);
    await this._tx(JOURNAL, "readwrite", (s) => s.put(e));
  }
  async getJournal(id) {
    return await this._tx(JOURNAL, "readonly", (s) => s.get(id)) ?? null;
  }
  async listJournal() {
    return this._tx(JOURNAL, "readonly", (s) => s.getAll());
  }
  /** Atomic read-modify-write. `mutate(current|null)` is SYNCHRONOUS and returns the next entry or throws (abort). */
  async casJournal(id, mutate) {
    const db = await this._db();
    return new Promise((ok, bad) => {
      const t = db.transaction(JOURNAL, "readwrite");
      const st = t.objectStore(JOURNAL);
      let next, err;
      const req = st.get(id);
      req.onsuccess = () => {
        try {
          next = mutate(req.result ? structuredClone(req.result) : null);
          if (!next || next.id !== id) fail("cas_shape", "mutate must return the entry with the same id");
          checkJournal(next);
          st.put(next);
        } catch (e) {
          err = e;
          t.abort();
        }
      };
      t.oncomplete = () => {
        db.close();
        ok(next);
      };
      t.onabort = () => {
        db.close();
        bad(err ?? t.error ?? new Error("transaction aborted"));
      };
    });
  }
};
var MemoryV2Store = class {
  constructor() {
    this.keys = /* @__PURE__ */ new Map();
    this.journal = /* @__PURE__ */ new Map();
  }
  async saveKey(rec) {
    validateGasRecord(rec);
    const prior = this.keys.get(rec.id);
    if (prior && prior.keyHash !== rec.keyHash) fail("record_key_changed", "a record id never changes its key");
    this.keys.set(rec.id, { ...rec });
  }
  async loadKey(id) {
    const r = this.keys.get(id);
    return r ? { ...r } : null;
  }
  async listKeys() {
    return [...this.keys.values()].map((r) => ({ ...r }));
  }
  async putJournal(e) {
    checkJournal(e);
    this.journal.set(e.id, JSON.parse(canon(e)));
  }
  async getJournal(id) {
    const e = this.journal.get(id);
    return e ? JSON.parse(JSON.stringify(e)) : null;
  }
  async listJournal() {
    return [...this.journal.values()].map((e) => JSON.parse(JSON.stringify(e)));
  }
  async casJournal(id, mutate) {
    const cur = this.journal.get(id);
    const next = mutate(cur ? JSON.parse(JSON.stringify(cur)) : null);
    if (!next || next.id !== id) fail("cas_shape", "mutate must return the entry with the same id");
    checkJournal(next);
    this.journal.set(id, JSON.parse(canon(next)));
    return JSON.parse(canon(next));
  }
};

// sdk/funding/chain-proof.mjs
var QTY = /^0x(0|[1-9a-f][0-9a-f]*)$/;
var H32 = /^0x[0-9a-f]{64}$/;
var ADDR = /^0x[0-9a-f]{40}$/;
var HEX = /^0x([0-9a-f]{2})*$/;
var ZERO32 = `0x${"0".repeat(64)}`;
var str = (v) => typeof v === "string" ? v.toLowerCase() : "";
function qty(v, name) {
  const s = str(v);
  if (!QTY.test(s)) fail("receipt_malformed", `${name} is not a canonical hex quantity`);
  return BigInt(s);
}
function h32(v, name) {
  const s = str(v);
  if (!H32.test(s)) fail("receipt_malformed", `${name} is not a 32-byte hash`);
  return s;
}
var toQty = (n) => `0x${n.toString(16)}`;
async function canonicalReceipt(rpc, txHash) {
  const h = h32(txHash, "txHash");
  if (h === ZERO32) fail("receipt_malformed", "txHash is zero");
  const rc = await rpc("eth_getTransactionReceipt", [h]);
  if (rc === null || rc === void 0) return null;
  if (typeof rc !== "object" || Array.isArray(rc)) fail("receipt_malformed", "receipt is not an object");
  for (const k of ["transactionHash", "transactionIndex", "blockHash", "blockNumber", "status", "logs"]) {
    if (!(k in rc)) fail("receipt_malformed", `receipt lacks ${k}`);
  }
  if (rc.blockHash === null || rc.blockNumber === null) return null;
  const bh = h32(rc.blockHash, "receipt.blockHash");
  if (bh === ZERO32) return null;
  const bn = qty(rc.blockNumber, "receipt.blockNumber");
  if (bn === 0n) fail("receipt_malformed", "receipt.blockNumber is zero");
  if (h32(rc.transactionHash, "receipt.transactionHash") !== h) fail("receipt_identity", "the receipt is for another transaction");
  const ti = qty(rc.transactionIndex, "receipt.transactionIndex");
  const st = str(rc.status);
  if (st !== "0x1" && st !== "0x0") fail("receipt_status_unknown", `receipt.status ${String(rc.status)} is neither 0x1 nor 0x0`);
  if (!Array.isArray(rc.logs)) fail("receipt_malformed", "receipt.logs is not an array");
  const blk = await rpc("eth_getBlockByNumber", [toQty(bn), false]);
  if (blk === null || blk === void 0) return null;
  if (qty(blk.number, "block.number") !== bn) fail("receipt_identity", "the canonical header at that height has another number");
  const hh = h32(blk.hash, "block.hash");
  if (hh === ZERO32) fail("receipt_malformed", "canonical header hash is zero");
  if (hh !== bh) return null;
  if (!Array.isArray(blk.transactions)) fail("receipt_malformed", "block.transactions is not an array");
  const at = blk.transactions[Number(ti)];
  if (str(typeof at === "string" ? at : at?.hash) !== h) fail("receipt_identity", "the transaction is not at its index in the canonical block");
  const seen = /* @__PURE__ */ new Set();
  rc.logs.forEach((l, k) => {
    const n = `logs[${k}]`;
    if (l === null || typeof l !== "object") fail("receipt_malformed", `${n} is not an object`);
    if (l.removed !== false) fail("receipt_log_removed", `${n}.removed must be exactly false`);
    if (h32(l.transactionHash, `${n}.transactionHash`) !== h) fail("receipt_identity", `${n} belongs to another transaction`);
    if (h32(l.blockHash, `${n}.blockHash`) !== bh) fail("receipt_identity", `${n} belongs to another block`);
    if (qty(l.blockNumber, `${n}.blockNumber`) !== bn) fail("receipt_identity", `${n} has another block number`);
    if (qty(l.transactionIndex, `${n}.transactionIndex`) !== ti) fail("receipt_identity", `${n} has another transaction index`);
    const li = qty(l.logIndex, `${n}.logIndex`);
    if (seen.has(li)) fail("receipt_malformed", `${n}.logIndex repeats`);
    seen.add(li);
    if (!ADDR.test(str(l.address))) fail("receipt_malformed", `${n}.address`);
    if (!Array.isArray(l.topics) || l.topics.length > 4) fail("receipt_malformed", `${n}.topics`);
    l.topics.forEach((t, j) => h32(t, `${n}.topics[${j}]`));
    if (!HEX.test(str(l.data))) fail("receipt_malformed", `${n}.data`);
  });
  if (st === "0x0") fail("tx_reverted", `transaction ${h} reverted on chain`, { txHash: h });
  return rc;
}
async function receiptFinality(rpc, rc) {
  const bn = qty(rc.blockNumber, "receipt.blockNumber");
  const bh = h32(rc.blockHash, "receipt.blockHash");
  if (bn === 0n || bh === ZERO32) fail("receipt_malformed", "receipt block identity is zero");
  const fin = await rpc("eth_getBlockByNumber", ["finalized", false]);
  if (!fin) return Object.freeze({ canonicalAtObservation: true, final: false, finalizedNumber: null });
  const fn = qty(fin.number, "finalized.number");
  const fh = h32(fin.hash, "finalized.hash");
  if (fn === 0n || fh === ZERO32) fail("receipt_malformed", "the finalized header identity is zero");
  if (fn < bn) return Object.freeze({ canonicalAtObservation: true, final: false, finalizedNumber: fn });
  const at = await rpc("eth_getBlockByNumber", [toQty(bn), false]);
  if (!at) fail("receipt_reorged", "no header at the receipt height although it is below the finalized head");
  if (qty(at.number, "header.number") !== bn) fail("receipt_identity", "the header at the receipt height has another number");
  const ah = h32(at.hash, "header.hash");
  if (fn === bn && ah !== fh) fail("receipt_identity", "finalized head and header at the same height differ");
  if (ah !== bh) fail("receipt_reorged", "the receipt's block is not in the finalized chain");
  return Object.freeze({ canonicalAtObservation: true, final: true, finalizedNumber: fn });
}
var VAULT_EVENTS = parseAbi([
  "event SessionOpened(bytes32 indexed sid, bytes32 indexed keyHash, uint64 expiresAt, uint256 actions, uint8 envs, uint256 budget6, string label)",
  "event SessionEnded(bytes32 indexed sid, uint8 reason, uint256 refund6, uint256 fee6)"
]);
var USDC_EVENTS = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)"
]);
var END_REASON_OWNER = 1;
function eventsOf(rc, address, abi) {
  const out = [];
  for (const l of rc.logs) {
    if (!sameAddr(l.address, address)) continue;
    let ev;
    try {
      ev = decodeEventLog({ abi, topics: l.topics, data: l.data, strict: true });
    } catch (e) {
      if (e?.name === "AbiEventSignatureNotFoundError") continue;
      fail("log_decode", `log ${l.logIndex} does not decode: ${e?.shortMessage ?? e?.message}`);
    }
    out.push({ name: ev.eventName, args: ev.args, logIndex: l.logIndex });
  }
  return out;
}
var one = (list, code, what) => {
  if (list.length !== 1) fail(code, `expected exactly one ${what}, found ${list.length}`);
  return list[0];
};
function proveEnded(rc, { vault, usdc, owner, sid, refund6 }) {
  const ended = one(
    eventsOf(rc, vault, VAULT_EVENTS).filter((e) => e.name === "SessionEnded" && lower(e.args.sid) === lower(sid)),
    "terminate_log",
    `SessionEnded for ${sid}`
  );
  if (Number(ended.args.reason) !== END_REASON_OWNER) fail("terminate_reason", `SessionEnded reason ${ended.args.reason} is not owner termination`);
  if (BigInt(ended.args.refund6) !== BigInt(refund6) || BigInt(ended.args.fee6) !== 0n) {
    fail("terminate_refund", `refund ${ended.args.refund6} / fee ${ended.args.fee6} is not ${refund6} / 0`);
  }
  one(eventsOf(rc, usdc, USDC_EVENTS).filter((e) => e.name === "Transfer" && sameAddr(e.args.from, vault) && sameAddr(e.args.to, owner) && BigInt(e.args.value) === BigInt(refund6)), "terminate_transfer", "USDC refund transfer vault -> owner");
  return Object.freeze({ kind: "ended", sid: lower(sid), refund6: BigInt(refund6) });
}
function proveOpened(rc, { vault, usdc, owner, sid, keyHash, digest, amount6, expiresAt, actions, envs }) {
  const o = one(
    eventsOf(rc, vault, VAULT_EVENTS).filter((e) => e.name === "SessionOpened" && lower(e.args.sid) === lower(sid)),
    "open_log",
    `SessionOpened for ${sid}`
  );
  const bad = [];
  if (lower(o.args.keyHash) !== lower(keyHash)) bad.push("keyHash");
  if (BigInt(o.args.budget6) !== BigInt(amount6)) bad.push("budget6");
  if (BigInt(o.args.expiresAt) !== BigInt(expiresAt)) bad.push("expiresAt");
  if (BigInt(o.args.actions) !== BigInt(actions)) bad.push("actions");
  if (Number(o.args.envs) !== Number(envs)) bad.push("envs");
  if (bad.length) fail("open_scope", `SessionOpened differs in [${bad}]`, { bad });
  const u = eventsOf(rc, usdc, USDC_EVENTS);
  one(
    u.filter((e) => e.name === "AuthorizationUsed" && sameAddr(e.args.authorizer, owner) && lower(e.args.nonce) === lower(digest)),
    "open_authorization",
    "AuthorizationUsed(owner, grant digest)"
  );
  one(
    u.filter((e) => e.name === "Transfer" && sameAddr(e.args.from, owner) && sameAddr(e.args.to, vault) && BigInt(e.args.value) === BigInt(amount6)),
    "open_transfer",
    "USDC deposit transfer owner -> vault"
  );
  return Object.freeze({ kind: "opened", sid: lower(sid), amount6: BigInt(amount6) });
}

// sdk/funding/funding-client.mjs
var CHAIN_ID = 8453;
var SIGN_WINDOW = 900n;
var OWNER_OP_WINDOW = 600n;
var MAX_OBSERVATION_AGE = 120n;
var RelayError = class extends Error {
  constructor(code, message, status, detail) {
    super(`${code}: ${message}`);
    this.name = "RelayError";
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
};
var RELAY_PATH = /^\/(?:funding\/[A-Za-z0-9/]+|owner(?:\/0x[0-9a-fA-F]{40})?|open|config)$/;
function relayClient(base, fetchImpl = globalThis.fetch?.bind(globalThis)) {
  if (typeof base !== "string" || !/^https?:\/\/[^/]+/.test(base)) fail("relay_base", "relay base must be an http(s) origin");
  if (typeof fetchImpl !== "function") fail("fetch_missing", "fetch is unavailable");
  const root = `${base.replace(/\/+$/, "")}/v1/sessions`;
  return async function request(method, path, body) {
    if (method !== "GET" && method !== "POST") fail("relay_method", `method ${method} is not used`);
    if (!RELAY_PATH.test(path)) fail("relay_path", `path ${path} is not an allowed relay route`);
    let res;
    try {
      res = await fetchImpl(root + path, {
        method,
        headers: body === void 0 ? {} : { "content-type": "application/json" },
        body: body === void 0 ? void 0 : canon(body)
      });
    } catch (e) {
      throw new RelayError("relay_unreachable", `relay unreachable: ${e?.message ?? e}`, 0, { sent: "unknown" });
    }
    const text = await res.text();
    let json = {};
    try {
      json = text ? normalizeWire(JSON.parse(text)) : {};
    } catch {
      json = {};
    }
    if (res.status === 202) return { ...json, pending: true, status: 202 };
    if (!res.ok) {
      throw new RelayError(
        typeof json.code === "string" ? json.code : "relay",
        String(json.error ?? json.message ?? `relay HTTP ${res.status}`),
        res.status,
        json
      );
    }
    return json;
  };
}
function jsonRpc(url, fetchImpl = globalThis.fetch?.bind(globalThis)) {
  let id = 0;
  return async function rpc(method, params = []) {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params })
    });
    const j = await res.json();
    if (j.error) fail("rpc_error", `${method}: ${j.error.message ?? "error"}`, j.error);
    return j.result;
  };
}
var READ_ABI = parseAbi([
  "function implementation() view returns (address)",
  "function gasAdapter() view returns (address)",
  "function legacyFactory() view returns (address)",
  "function usdc() view returns (address)",
  "function maxEthOut() view returns (uint256)",
  "function vaultFor(address owner) view returns (address)",
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function balanceOf(address account) view returns (uint256)",
  "function free() view returns (uint256)",
  "function addr(bytes32 key) view returns (address)",
  "function held(bytes32 id) view returns (uint8 env, bytes32 promoted)"
]);
async function ethCall(rpc, to, functionName, args = [], block = "latest", abi = READ_ABI) {
  const data = encodeFunctionData({ abi, functionName, args });
  const out = await rpc("eth_call", [{ to, data }, block]);
  return decodeFunctionResult({ abi, functionName, data: out });
}
async function pinBlock(rpc, now = BigInt(Math.floor(Date.now() / 1e3))) {
  const blk = await rpc("eth_getBlockByNumber", ["latest", false]);
  if (!blk?.number || !blk?.hash || blk.timestamp === void 0) fail("block_unreadable", "latest block unreadable");
  if (!/^0x[0-9a-f]{64}$/.test(lower(blk.hash)) || lower(blk.hash) === ZERO_HASH) fail("block_unreadable", "latest block hash is malformed");
  const ts = BigInt(blk.timestamp);
  if (BigInt(now) > ts + MAX_OBSERVATION_AGE) fail("block_stale", `latest block is ${BigInt(now) - ts}s old`);
  const pin = Object.freeze({ number: BigInt(blk.number), tag: blk.number, hash: lower(blk.hash), timestamp: ts });
  return Object.freeze({ ...pin, async recheck() {
    const again = await rpc("eth_getBlockByNumber", [pin.tag, false]);
    if (!again || lower(again.hash) !== pin.hash || BigInt(again.number) !== pin.number) {
      fail("block_reorged", `block ${pin.number} was replaced while it was read`);
    }
    return pin;
  } });
}
var RUNTIME_SCHEMA = "enclave-funding-browser-runtime-r1";
var RUNTIME_KEYS = [
  "schema",
  "chainId",
  "factory",
  "implementation",
  "gasAdapter",
  "legacyFactory",
  "usdc",
  "feeTiers",
  "codehashes",
  "source"
];
function exact(o, keys, name) {
  if (o === null || typeof o !== "object" || Array.isArray(o)) fail("object_type", `${name} must be an object`);
  const extra = Object.keys(o).filter((k) => !keys.includes(k));
  const missing = keys.filter((k) => o[k] === void 0);
  if (extra.length || missing.length) fail("runtime_shape", `${name}: extra [${extra}] missing [${missing}]`);
}
function parseRuntimePins(p) {
  if (p === null || p === void 0) {
    fail("funding_runtime_unconfigured", "no DEPLOYED successor runtime is configured for this site (FUNDING_RUNTIME is null); nothing is offered");
  }
  exact(p, RUNTIME_KEYS, "runtime");
  if (p.schema !== RUNTIME_SCHEMA) fail("runtime_schema", `runtime.schema must be ${RUNTIME_SCHEMA}`);
  if (Number(p.chainId) !== CHAIN_ID) fail("chain_unsupported", "runtime pins are for Base 8453 only");
  exact(p.codehashes, ["factory", "implementation", "gasAdapter"], "runtime.codehashes");
  exact(p.source, ["kind", "deployTxs", "reviewedBy"], "runtime.source");
  if (p.source.kind !== "deployed-receipts") fail("runtime_provisional", "runtime pins must come from deployment receipts, not a proposal");
  if (!Array.isArray(p.source.deployTxs) || p.source.deployTxs.length === 0) fail("runtime_provenance", "runtime.source.deployTxs is empty");
  p.source.deployTxs.forEach((h, k) => parseHex32(h, `runtime.source.deployTxs[${k}]`, { nonZero: true }));
  if (!Array.isArray(p.feeTiers) || p.feeTiers.length === 0) fail("runtime_fee_tiers", "runtime.feeTiers is empty");
  const feeTiers = p.feeTiers.map((t) => Number(parseUint(t, 24, "feeTier")));
  if (feeTiers.some((t) => ![100, 500, 3e3].includes(t))) fail("runtime_fee_tiers", "the adapter accepts 100/500/3000 only");
  return Object.freeze({
    factory: parseAddress(p.factory, "runtime.factory"),
    implementation: parseAddress(p.implementation, "runtime.implementation"),
    gasAdapter: parseAddress(p.gasAdapter, "runtime.gasAdapter"),
    legacyFactory: parseAddress(p.legacyFactory, "runtime.legacyFactory"),
    usdc: parseAddress(p.usdc, "runtime.usdc"),
    feeTiers: Object.freeze(feeTiers),
    codehashes: Object.freeze({
      factory: parseHex32(p.codehashes.factory, "codehashes.factory", { nonZero: true }),
      implementation: parseHex32(p.codehashes.implementation, "codehashes.implementation", { nonZero: true }),
      gasAdapter: parseHex32(p.codehashes.gasAdapter, "codehashes.gasAdapter", { nonZero: true })
    })
  });
}
async function verifyRuntime({ pins, rpc, relay, owner, now }) {
  const P = parseRuntimePins(pins);
  const o = parseAddress(owner, "owner");
  if (BigInt(await rpc("eth_chainId", [])) !== BigInt(CHAIN_ID)) fail("chain_mismatch", "the RPC is not Base 8453");
  const pin = await pinBlock(rpc, now);
  const tag = pin.tag;
  for (const k of ["factory", "implementation", "gasAdapter"]) {
    const code = await rpc("eth_getCode", [P[k], tag]);
    if (!code || code === "0x") fail("missing_code", `${k} ${P[k]} has no code at block ${pin.number}`);
    if (keccak256(code) !== P.codehashes[k]) fail("codehash_mismatch", `${k} ${P[k]} runtime differs from its pin`);
  }
  const eq = async (label, to, fn, args, want) => {
    const got = await ethCall(rpc, to, fn, args, tag);
    if (!sameAddr(got, want)) fail("identity_mismatch", `${label} is ${got}, pinned ${want}`);
  };
  await eq("factory.implementation()", P.factory, "implementation", [], P.implementation);
  await eq("implementation.gasAdapter()", P.implementation, "gasAdapter", [], P.gasAdapter);
  await eq("implementation.legacyFactory()", P.implementation, "legacyFactory", [], P.legacyFactory);
  await eq("implementation.usdc()", P.implementation, "usdc", [], P.usdc);
  const vault = predictVault(P.factory, P.implementation, o);
  await eq("factory.vaultFor(owner)", P.factory, "vaultFor", [o], vault);
  const adapterMaxEthOut = BigInt(await ethCall(rpc, P.gasAdapter, "maxEthOut", [], tag));
  const legacyVault = getAddress(await ethCall(rpc, P.legacyFactory, "vaultFor", [o], tag));
  await pin.recheck();
  let intake = null;
  let intakeWhy = null;
  try {
    const c = await relay("GET", "/funding/config");
    if (c.enabled !== true || Number(c.chainId) !== CHAIN_ID || Number(c.action) !== ACTION_GAS_FUND) fail("relay_config", "relay funding config is not enabled for Base action 10");
    for (const [k, want] of [["factory", P.factory], ["implementation", P.implementation], ["adapter", P.gasAdapter], ["legacyFactory", P.legacyFactory]]) {
      if (!sameAddr(c[k], want)) fail("relay_identity", `relay ${k} ${c[k]} differs from the verified pin ${want}`);
    }
    if (BigInt(c.adapterMaxEthOut) !== adapterMaxEthOut) fail("relay_identity", "relay adapterMaxEthOut differs from the chain");
    const tiers = (c.feeTiers ?? []).map(Number);
    if (tiers.length === 0 || tiers.some((t) => !P.feeTiers.includes(t))) fail("relay_identity", "relay fee tiers are not a subset of the pins");
    intake = Object.freeze({
      feeTiers: Object.freeze(tiers),
      relayer: parseAddress(c.relayer, "relayer"),
      openEnabled: c.open?.enabled === true,
      ownerEnabled: c.owner?.enabled === true,
      notAfter: String(c.notAfter)
    });
  } catch (e) {
    if (e?.code !== "funding_disabled" && e?.code !== "relay_unreachable") throw e;
    intakeWhy = e.message;
  }
  const cfg = fundingConfig({
    chainId: CHAIN_ID,
    factory: P.factory,
    implementation: P.implementation,
    vault,
    owner: o,
    gasAdapter: P.gasAdapter,
    legacyFactory: P.legacyFactory,
    legacyVault,
    adapterMaxEthOut,
    adapterFeeTiers: intake ? [...intake.feeTiers] : [...P.feeTiers]
  });
  return Object.freeze({
    cfg,
    pins: P,
    intake,
    intakeWhy,
    relayer: intake?.relayer ?? null,
    block: Object.freeze({ number: pin.number, hash: pin.hash, timestamp: pin.timestamp })
  });
}
var LEDGER_ROW = [
  ["id", "bytes32"],
  ["owner", "address"],
  ["appRef", "string"],
  ["ports", "string"],
  ["configCid", "string"],
  ["gpuMilli", "uint16"],
  ["cpuMilli", "uint16"],
  ["appPort", "uint32"],
  ["isPublic", "bool"],
  ["active", "bool"],
  ["createdAt", "uint64"],
  ["rate", "uint256"],
  ["balance6", "uint256"],
  ["spent6", "uint256"],
  ["runner", "bytes32"],
  ["runnerOperator", "address"],
  ["leaseUntil", "uint64"]
].map(([name, type]) => ({ name, type }));
var LEDGER_GET = Object.freeze([{
  type: "function",
  name: "get",
  stateMutability: "view",
  inputs: [{ type: "bytes32" }],
  outputs: [{ type: "tuple", components: LEDGER_ROW }]
}]);
var bookKey = (s) => `0x${Array.from(new TextEncoder().encode(s), (x) => x.toString(16).padStart(2, "0")).join("").padEnd(64, "0")}`;
var MAX_GRANT_APPS2 = 8;
async function freshRecoveryScope({ rpc, book, owner, legacyVault, deploymentIds, now }) {
  const o = parseAddress(owner, "owner");
  const lv = parseAddress(legacyVault, "legacyVault");
  if (!Array.isArray(deploymentIds) || deploymentIds.length === 0) fail("scope_empty", "no recovery deployments are configured");
  const pin = await pinBlock(rpc, now);
  const ledger = await ethCall(rpc, parseAddress(book, "book"), "addr", [bookKey("deployments")], pin.tag);
  const deployments = /* @__PURE__ */ new Map();
  for (const raw of deploymentIds) {
    const id = parseHex32(lower(raw), "deployment", { nonZero: true });
    if (deployments.has(id)) fail("scope_duplicate", `deployment ${id} listed twice`);
    const row = await ethCall(rpc, ledger, "get", [id], pin.tag, LEDGER_GET);
    if (lower(row.id) !== id) fail("scope_missing", `deployment ${id} is not in the ledger`);
    const m = /^catalog:\/\/(0x[0-9a-fA-F]{64})\/(0|[1-9]\d*)$/.exec(row.appRef);
    if (!m) fail("scope_app_unresolvable", `deployment ${id} runs no catalog app; a gas grant cannot name it`);
    let holder, env;
    if (sameAddr(row.owner, o)) {
      holder = o;
      env = 2;
    } else if (sameAddr(row.owner, lv)) {
      holder = lv;
      const [heldEnv] = await ethCall(rpc, lv, "held", [id], pin.tag);
      env = Number(heldEnv);
      if (env !== 1 && env !== 2) fail("scope_not_adopted", `deployment ${id} is in the legacy vault but not adopted (held env ${env})`);
    } else fail("scope_holder_foreign", `deployment ${id} is held by ${row.owner}, not the owner or the legacy vault`);
    deployments.set(id, Object.freeze({ holder, env, appId: lower(m[1]), active: row.active }));
  }
  await pin.recheck();
  const byApp = {};
  for (const [id, d] of deployments) (byApp[d.appId] ??= []).push(id);
  const appIds = Object.keys(byApp).sort();
  const partitionRequired = appIds.length > MAX_GRANT_APPS2;
  return Object.freeze({
    deployments,
    appIds: Object.freeze(appIds),
    byApp: Object.freeze(byApp),
    partitionRequired,
    constraint: partitionRequired ? `${appIds.length} distinct apps > ${MAX_GRANT_APPS2} per grant: name an explicit partition (at least ${Math.ceil(appIds.length / MAX_GRANT_APPS2)} gas grants, disjoint, covering every app)` : null,
    block: pin.number,
    blockHash: pin.hash,
    timestamp: pin.timestamp
  });
}
var GAS_GRANT_CANDIDATE = Object.freeze({
  preset: "gas-recovery",
  actions: Object.freeze(["gas.fund"]),
  environments: Object.freeze(["staging", "prod"]),
  budget: 1000000n,
  spendPerPeriod: 1000000n,
  periodSeconds: 86400n,
  opsPerPeriod: 20n,
  maxFeePerOp: 50000n,
  maxAppFeePerHour: 0n,
  maxRatePerHour: 0n,
  maxGasUsdcPerOp: 100000n,
  maxUsdcPerEth6: 2500000000n,
  maxEthPerOp: 20000000000000n,
  measurement: ZERO_HASH
});
function buildGasGrant(cfg, { now, sessionKey, appIds, expiresAt, legacyExpiresAt, grantNonce, signBefore, label, budget, part }) {
  const T = GAS_GRANT_CANDIDATE;
  let b, spend, ops;
  if (part === void 0) {
    b = budget === void 0 ? T.budget : parseUint(budget, 128, "budget");
    if (b !== T.budget) fail("gas_budget_not_candidate", `gas budget ${b} differs from the reviewed candidate ${T.budget}; a different split needs a new review`);
    spend = T.spendPerPeriod;
    ops = T.opsPerPeriod;
  } else {
    b = parseUint(part.budget6, 128, "part.budget6");
    if (b === 0n || b > T.budget) fail("gas_part_budget", `a gas part budget must be 1..${T.budget}`);
    if (budget !== void 0 && parseUint(budget, 128, "budget") !== b) fail("gas_budget_not_candidate", "budget differs from the part");
    ops = parseUint(part.opsPerPeriod, 32, "part.opsPerPeriod");
    if (ops === 0n || ops > T.opsPerPeriod) fail("gas_part_ops", `a gas part may allow 1..${T.opsPerPeriod} ops per period`);
    spend = b;
  }
  if (!Array.isArray(appIds) || appIds.length === 0 || appIds.length > MAX_GRANT_APPS2) fail("gas_scope_apps", `1..${MAX_GRANT_APPS2} app ids required`);
  const apps = appIds.map((a, k) => parseHex32(lower(a), `appIds[${k}]`, { nonZero: true }));
  if (new Set(apps).size !== apps.length) fail("gas_scope_apps", "app ids must be distinct");
  const exp = parseUint(expiresAt, 64, "expiresAt");
  if (exp > parseUint(legacyExpiresAt, 64, "legacyExpiresAt")) fail("gas_expiry_after_legacy", "the gas grant may not outlive the old grant");
  const grant = {
    label: String(label),
    preset: T.preset,
    sessionKey,
    actions: [...T.actions],
    apps,
    environments: [...T.environments],
    budget: b,
    spendPerPeriod: spend,
    periodSeconds: T.periodSeconds,
    opsPerPeriod: ops,
    maxFeePerOp: T.maxFeePerOp,
    maxAppFeePerHour: T.maxAppFeePerHour,
    maxRatePerHour: T.maxRatePerHour,
    maxGasUsdcPerOp: T.maxGasUsdcPerOp,
    maxUsdcPerEth6: T.maxUsdcPerEth6,
    maxEthPerOp: T.maxEthPerOp,
    expiresAt: exp,
    measurement: T.measurement,
    grantNonce,
    signBefore
  };
  const built = buildGrantV2(cfg, { domainVersion: "2", now, grant });
  if (built.actionsMask !== 1n << BigInt(ACTION_GAS_FUND) || built.envsMask !== 3 || !built.gasFundGranted) {
    fail("gas_grant_shape", "the gas grant must be exactly action 10 over staging+prod");
  }
  return built;
}
var grantBody = (built) => jsonable(built.typedData.message);
function rebuildGasReview(cfg, grantJson, digest, now) {
  const built = buildGrantV2(cfg, { domainVersion: "2", now, grant: { ...grantJson } });
  if (lower(built.digest) !== lower(digest)) fail("review_digest_mismatch", "stored gas grant does not hash to its stored digest");
  if (built.actionsMask !== 1n << BigInt(ACTION_GAS_FUND) || built.envsMask !== 3) fail("gas_grant_shape", "stored gas grant is not action 10 over staging+prod");
  return built;
}
function selectGasRecord(records, scope, deployment) {
  const d = parseHex32(lower(deployment), "deployment", { nonZero: true });
  const entry = scope.deployments.get(d);
  if (!entry) fail("deployment_out_of_scope", `deployment ${d} is not in the freshly checked recovery scope`);
  const covers = (r) => Array.isArray(r.grant?.apps) && r.grant.apps.map(lower).includes(entry.appId);
  const matching = records.filter(covers);
  const open = matching.filter((r) => r.status === "open");
  if (open.length === 0) {
    fail("matching_grant_not_open", `no OPEN gas grant names app ${entry.appId}`, { matching: matching.map((r) => ({ id: r.id, status: r.status })) });
  }
  if (open.length > 1) fail("matching_grant_ambiguous", `${open.length} open gas grants name app ${entry.appId}`);
  return open[0];
}
var DOMAIN_FIELDS = Object.freeze([
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" }
]);
async function walletSignTyped(provider, address, td) {
  if (!provider || typeof provider.request !== "function") fail("wallet_missing", "connect a wallet first");
  const payload = JSON.stringify({
    types: { EIP712Domain: DOMAIN_FIELDS, ...td.types },
    domain: td.domain,
    primaryType: td.primaryType,
    message: td.message
  }, (_k, v) => typeof v === "bigint" ? v.toString() : v);
  const sig = await provider.request({ method: "eth_signTypedData_v4", params: [address, payload] });
  if (typeof sig !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(sig)) {
    fail("wallet_signature_format", "the wallet returned no 65-byte ECDSA signature (contract wallets are not supported here)");
  }
  const who = await recoverTypedDataAddress({
    domain: td.domain,
    types: td.types,
    primaryType: td.primaryType,
    message: td.message,
    signature: sig
  });
  if (!sameAddr(who, address)) fail("wallet_signed_other", "the signature does not recover to the owner for this exact digest");
  return sig;
}
var RECEIVE_TYPES = Object.freeze({ ReceiveWithAuthorization: Object.freeze([
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" }
]) });
async function usdcDomain(rpc, usdc) {
  const [name, version3] = [await ethCall(rpc, usdc, "name"), await ethCall(rpc, usdc, "version")];
  return Object.freeze({ name, version: version3, chainId: CHAIN_ID, verifyingContract: getAddress(usdc) });
}
function depositTypedData(usdc, { from, to, value, nonce, validBefore }) {
  return {
    domain: usdc,
    types: RECEIVE_TYPES,
    primaryType: "ReceiveWithAuthorization",
    message: {
      from: getAddress(from),
      to: getAddress(to),
      value: BigInt(value),
      validAfter: 0n,
      validBefore: BigInt(validBefore),
      nonce: parseHex32(nonce, "deposit nonce", { nonZero: true })
    }
  };
}
function requireApproval(approval, digest, what) {
  if (!approval || approval.rootReviewed !== true || lower(approval.digest) !== lower(digest)) {
    fail("approval_required", `${what}: no reviewed approval for digest ${digest}; nothing was signed`);
  }
}
async function journal(store, entry) {
  await store.putJournal({ ...entry, at: Number(entry.at ?? Math.floor(Date.now() / 1e3)) });
}
async function prepareGasOpen({
  runtime,
  store,
  relayBase,
  appIds,
  legacyExpiresAt,
  expiresAt,
  label = "Gas recovery",
  now,
  subtle,
  rng,
  signBefore,
  part
}) {
  const cfg = runtime.cfg;
  const key = await newGasKey(subtle);
  const rec = newGasRecord({
    key,
    chainId: CHAIN_ID,
    relay: relayBase,
    owner: cfg.owner,
    vault: cfg.vault,
    factory: cfg.factory,
    implementation: cfg.implementation,
    label,
    now
  });
  const built = buildGasGrant(cfg, {
    now,
    sessionKey: key.keyHash,
    appIds,
    expiresAt,
    legacyExpiresAt,
    grantNonce: randomHex32(rng),
    signBefore: signBefore ?? BigInt(now) + SIGN_WINDOW,
    label,
    part
  });
  Object.assign(rec, { grant: grantBody(built), grantDigest: built.digest, sid: built.sessionId, status: "reviewed" });
  await store.saveKey(rec);
  return { record: rec, review: built };
}
async function signGasOpen({ runtime, provider, rpc, review, approval, now }) {
  requireApproval(approval, review.digest, "gas grant");
  const cfg = runtime.cfg;
  const g = review.typedData.message;
  if (BigInt(now) > g.signBefore) fail("sign_window_passed", "the grant's signBefore passed; prepare a fresh one");
  const ownerSig = await walletSignTyped(provider, cfg.owner, review.typedData);
  const usdc = await usdcDomain(rpc, runtime.pins.usdc);
  const dep = depositTypedData(usdc, { from: cfg.owner, to: cfg.vault, value: g.budget, nonce: review.digest, validBefore: g.signBefore });
  const depSig = await walletSignTyped(provider, cfg.owner, dep);
  return { owner: cfg.owner, grant: grantBody(review), ownerSig, deposit: { validAfter: "0", validBefore: g.signBefore.toString(), sig: depSig } };
}
async function proveGasOpen({ runtime, rpc, review, txHash }) {
  const rc = await canonicalReceipt(rpc, txHash);
  if (!rc) return null;
  const g = review.typedData.message;
  return { receipt: rc, proof: proveOpened(rc, {
    vault: runtime.cfg.vault,
    usdc: runtime.pins.usdc,
    owner: runtime.cfg.owner,
    sid: review.sessionId,
    keyHash: g.sessionKey,
    digest: review.digest,
    amount6: g.budget,
    expiresAt: g.expiresAt,
    actions: review.actionsMask,
    envs: review.envsMask
  }) };
}
async function submitGasOpen({ runtime, store, relay, rpc, record, review, body, now }) {
  if (!runtime.intake?.openEnabled) fail("intake_off", `successor intake/open is off: ${runtime.intakeWhy ?? "open disabled"}`);
  const id = `gas-open:${review.sessionId}`;
  const base = { id, kind: "gas-open", sid: review.sessionId, grantDigest: review.digest, at: now };
  await journal(store, { ...base, status: "submitting" });
  let out;
  try {
    out = await relay("POST", "/funding/open", body);
  } catch (e) {
    await journal(store, { ...base, status: e.code === "relay_unreachable" ? "unknown" : "refused", code: e.code });
    throw e;
  }
  if (out.sid !== void 0 && lower(out.sid) !== review.sessionId) fail("relay_sid_mismatch", `relay reported ${out.sid}, expected ${review.sessionId}`);
  const txHash = out.txHash ? lower(out.txHash) : null;
  if (!txHash) {
    await journal(store, { ...base, status: "pending" });
    return { pending: true, txHash: null, sid: review.sessionId };
  }
  const proven = await proveGasOpen({ runtime, rpc, review, txHash });
  const rec = await store.loadKey(record.id);
  Object.assign(rec, {
    status: proven ? "open" : "submitted",
    open: { txHash, block: proven ? Number(BigInt(proven.receipt.blockNumber)) : null }
  });
  await store.saveKey(rec);
  await journal(store, { ...base, status: proven ? "done" : "pending", txHashes: [txHash] });
  return { pending: !proven, txHash, sid: review.sessionId };
}
function grantOf(record) {
  const g = record.grant;
  return {
    maxFeePerOp: BigInt(g.maxFeePerOp),
    maxGasUsdcPerOp: BigInt(g.maxGasUsdcPerOp),
    maxUsdcPerEth6: BigInt(g.maxUsdcPerEth6),
    maxEthPerOp: BigInt(g.maxEthPerOp),
    apps: g.apps.map(lower),
    environments: g.environments
  };
}
async function quoteGasFund({ runtime, record, relay, scope, deployment, ethOut, feeTier, now, journalEntries = [] }) {
  const cfg = runtime.cfg;
  if (!runtime.intake) fail("intake_off", `gas.fund intake is off: ${runtime.intakeWhy ?? "unknown"}`);
  if (record.status !== "open" || !record.sid) fail("session_not_open", "the gas session is not open");
  if (scope.timestamp !== void 0 && BigInt(now) > BigInt(scope.timestamp) + MAX_OBSERVATION_AGE) {
    fail("scope_stale", "the recovery scope was read too long ago; re-read it before quoting");
  }
  const unresolved = journalEntries.filter((e) => e.kind === "gas-execute" && e.sid === record.sid && !["settled", "refused"].includes(e.status));
  if (unresolved.length) fail("unreconciled_execute", "an earlier gas.fund is not reconciled; reconcile it first (never resent)", { ids: unresolved.map((e) => e.id) });
  const d = parseHex32(lower(deployment), "deployment", { nonZero: true });
  const entry = scope.deployments.get(d);
  if (!entry) fail("deployment_out_of_scope", `deployment ${d} is not in the freshly checked recovery scope`);
  const g = grantOf(record);
  if (!g.apps.includes(entry.appId)) fail("app_not_granted", "the deployment's app is not named by the gas grant");
  if (!g.environments.includes(entry.env === 1 ? "staging" : "prod")) fail("env_not_granted", "environment not granted");
  const eo = parseUint(ethOut, 96, "ethOut");
  if (eo === 0n || eo > g.maxEthPerOp) fail("eth_cap", `ethOut must be 1..${g.maxEthPerOp}`);
  const tier = Number(parseUint(feeTier, 24, "feeTier"));
  const view = await relay("GET", `/funding/session/${cfg.vault}/${record.sid}`);
  if (view?.state?.live !== true) fail("session_not_live", "the relay reports this session is not live");
  if (lower(view.state.keyHash) !== record.keyHash) fail("key_mismatch", "the session's key hash is not this browser's key");
  const balance6 = BigInt(view.state.balance6);
  const q = await relay("POST", "/funding/quote", { vault: cfg.vault, sid: record.sid, deployment: d, ethOut: eo, feeTier: tier });
  if (!sameAddr(q.vault, cfg.vault) || lower(q.sid) !== record.sid || Number(q.action) !== ACTION_GAS_FUND || Number(q.chainId) !== CHAIN_ID) {
    fail("quote_identity", "the quote names another vault, session, action or chain");
  }
  const i = q.intent ?? {};
  if (lower(i.deployment) !== d || BigInt(i.ethOut) !== eo || Number(i.fee) !== tier) fail("quote_changed_request", "the quote changed the requested deployment, amount or tier");
  if (!sameAddr(i.expectedOwner, entry.holder)) fail("holder_mismatch", "the quote's holder differs from the freshly checked holder");
  const call = buildGasFundCall(cfg, {
    domainVersion: "2",
    now,
    sessionId: record.sid,
    nonce: q.nonce,
    action: ACTION_GAS_FUND,
    intent: { payer: i.payer, deployment: d, expectedOwner: i.expectedOwner, ethOut: i.ethOut, maxUsdcIn6: i.maxUsdcIn6, fee: Number(i.fee), deadline: i.deadline },
    fee: q.fee,
    deadline: q.deadline
  });
  if (call.args !== lower(q.args) || call.argsHash !== lower(q.argsHash)) fail("quote_args_mismatch", "relay args are not the codec encoding of its intent");
  const fee = call.execute.fee;
  const max2 = call.intent.maxUsdcIn6;
  if (fee > g.maxFeePerOp) fail("fee_exceeds_grant", `fee ${fee} > maxFeePerOp ${g.maxFeePerOp}`);
  if (max2 > g.maxGasUsdcPerOp) fail("gas_cap", `maxUsdcIn6 ${max2} > maxGasUsdcPerOp ${g.maxGasUsdcPerOp}`);
  if (max2 * 10n ** 18n > g.maxUsdcPerEth6 * eo) fail("price_cap", "the quote's price exceeds maxUsdcPerEth6; the cap is never raised");
  const total = max2 + fee;
  if (q.maximum && BigInt(q.maximum.totalMaximum6) !== total) fail("quote_total_mismatch", "relay maximum differs from intent + fee");
  if (total > balance6) fail("quote_exceeds_budget", `needs ${total}, the session holds ${balance6}; the budget is not raised and nothing is signed`);
  return Object.freeze({
    call,
    sid: record.sid,
    deployment: d,
    holder: entry.holder,
    env: entry.env,
    totals: Object.freeze({ maxUsdcIn6: max2, fee6: fee, totalMaximum6: total, balance6 }),
    quote: q
  });
}
async function verifySettlement({ runtime, rpc, txHash, call }) {
  const rc = await canonicalReceipt(rpc, txHash);
  if (!rc) return null;
  if (!sameAddr(rc.to, runtime.cfg.vault)) fail("settlement_target", "the transaction did not call the configured vault");
  const logs = rc.logs.map((l) => ({ address: lower(l.address), topics: l.topics.map(lower), data: lower(l.data) }));
  return parseGasSettlement(runtime.cfg, { call: {
    sessionId: call.execute.sessionId,
    nonce: call.execute.nonce,
    args: call.args,
    fee: call.execute.fee
  }, logs, sessionOpAmountSemantics: "actual", ...runtime.relayer ? { submitter: runtime.relayer } : {} });
}
function controlsTarget(pins, owner) {
  const o = parseAddress(owner, "owner");
  const vault = predictVault(pins.factory, pins.implementation, o);
  return Object.freeze({
    owner: o,
    vault,
    domain: Object.freeze({ name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId: CHAIN_ID, verifyingContract: vault })
  });
}
var typedV2 = (domain, primaryType, message) => {
  const td = { domain, types: { [primaryType]: TYPES_V2[primaryType] }, primaryType, message };
  return { typedData: td, digest: hashTypedData(td) };
};
async function ownerControl({ target, provider, relay, store, op, sessionId, amount, now, rng }) {
  if (op !== "terminate" && op !== "withdraw") fail("owner_op_unsupported", "this page offers terminate and withdraw only");
  const opNonce = randomHex32(rng);
  const signBefore = BigInt(now) + OWNER_OP_WINDOW;
  const message = op === "terminate" ? { sessionId: parseHex32(lower(sessionId), "sessionId", { nonZero: true }), opNonce, signBefore } : { amount: parseUint(amount, 128, "amount"), opNonce, signBefore };
  if (op === "withdraw" && message.amount === 0n) fail("withdraw_zero", "amount must be positive");
  const built = typedV2(target.domain, op === "terminate" ? "Terminate" : "Withdraw", message);
  const sig = await walletSignTyped(provider, target.owner, built.typedData);
  const base = {
    id: `gas-owner:${opNonce}`,
    kind: "gas-owner",
    op,
    digest: built.digest,
    at: now,
    ...op === "terminate" ? { sessionId: message.sessionId } : { amount: message.amount }
  };
  await journal(store, { ...base, status: "submitting" });
  try {
    const out = await relay("POST", "/funding/owner", { owner: target.owner, vault: target.vault, op, args: jsonable(message), sig });
    await journal(store, { ...base, status: out.pending ? "pending" : "submitted", txHashes: out.txHash ? [lower(out.txHash)] : [] });
    return out;
  } catch (e) {
    await journal(store, { ...base, status: e.code === "relay_unreachable" ? "unknown" : "refused", code: e.code });
    throw e;
  }
}
async function endGasSession({ record, relay, store, now, subtle }) {
  const vault = predictVault(record.factory, record.implementation, record.owner);
  if (!sameAddr(vault, record.vault)) fail("record_vault", "the record's vault is not its factory's CREATE2 vault for its owner");
  const deadline = BigInt(now) + OWNER_OP_WINDOW;
  const built = typedV2(
    Object.freeze({ name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId: CHAIN_ID, verifyingContract: vault }),
    "SessionEnd",
    { sessionId: parseHex32(lower(record.sid), "sid", { nonZero: true }), deadline }
  );
  const signer = signerFor(record.privateKey, BigInt(record.x), BigInt(record.y), subtle);
  const { r, s } = await signer.signDigest(built.digest);
  const base = { id: `gas-end:${record.sid}`, kind: "gas-end", sid: record.sid, digest: built.digest, at: now };
  await journal(store, { ...base, status: "submitting" });
  let out;
  try {
    out = await relay("POST", "/funding/end", { vault, sid: record.sid, deadline, x: signer.x, y: signer.y, r, s });
  } catch (e) {
    await journal(store, { ...base, status: e.code === "relay_unreachable" ? "unknown" : "refused", code: e.code });
    throw e;
  }
  await journal(store, { ...base, status: out.pending ? "pending" : "submitted", txHashes: out.txHash ? [lower(out.txHash)] : [] });
  return out;
}
var reconcileFundingTx = (relay, txHash) => relay("GET", `/funding/tx/${parseHex32(lower(txHash), "txHash")}`);

// sdk/funding/migration.mjs
var MIGRATION_SCHEMA = "enclave-funding-migration-plan-r3";
var MAX_COMBINED6 = 30000000n;
var V1_GRANT_FIELDS = Object.freeze([
  "label",
  "preset",
  "sessionKey",
  "actions",
  "apps",
  "environments",
  "budget",
  "spendPerPeriod",
  "periodSeconds",
  "opsPerPeriod",
  "maxFeePerOp",
  "maxAppFeePerHour",
  "maxRatePerHour",
  "expiresAt",
  "measurement",
  "grantNonce",
  "signBefore"
]);
var REPLACED_FIELDS = Object.freeze(["budget", "grantNonce", "signBefore"]);
var V1_BIG = ["budget", "spendPerPeriod", "maxFeePerOp", "maxAppFeePerHour", "maxRatePerHour", "expiresAt", "signBefore"];
var V1_NUM = ["periodSeconds", "opsPerPeriod"];
var GAS_VOLATILE = ["sessionKey", "grantNonce", "signBefore"];
var ORDER = Object.freeze(["terminate", "legacyOpen", "gasOpen"]);
var PART_NAME = /^[a-z0-9-]{1,24}$/;
var isGasStep = (k) => k === "gasOpen" || typeof k === "string" && k.startsWith("gasOpen:") && PART_NAME.test(k.slice(8));
var STEP_NOTES = Object.freeze({
  withdraw: "not-applicable: SessionVault._end refunds the old escrow to the owner wallet; no vault free balance is created",
  legacyFunding: "relay POST /open -> factory.openWithDepositFor (owner EIP-3009, nonce = replacement grant digest)",
  gasFunding: "relay POST /v1/sessions/funding/open -> successor openWithDeposit, once per gas part (owner EIP-3009, nonce = that part's grant digest)",
  interruption: "API session auth stops when the original relay simulates terminate and resumes when the replacement open is proven and the active pointer moves; a pending or lost reply extends it until reconcile proves the step.",
  proofs: "terminate: SessionEnded(oldSid, reason 1, refund = full balance, fee 0) + USDC Transfer(vault -> owner). open: SessionOpened(sid, key, scope, budget) + USDC AuthorizationUsed(owner, digest) + Transfer(owner -> vault). All from a canonical receipt, re-proven at the original block before every later send or adoption; finality recorded separately."
});
var LOCAL_ABI = parseAbi([
  "function owner() view returns (address)",
  "function free() view returns (uint256)",
  "function vaultFor(address owner) view returns (address)",
  "function balanceOf(address account) view returns (uint256)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)"
]);
var toQty2 = (n) => `0x${BigInt(n).toString(16)}`;
function legacyChain(rpc, S) {
  const call = (to, fn, args, block, abi = LOCAL_ABI) => ethCall(rpc, to, fn, args, block ?? "latest", abi);
  return Object.freeze({
    pin: (now) => pinBlock(rpc, now),
    async sessionOf(vault, sid, block) {
      const [s, live, apps] = await call(vault, "sessionOf", [sid], block, S.sessionVaultAbi);
      return normState(s, live, apps);
    },
    owner: (vault, block) => call(vault, "owner", [], block),
    free: async (vault, block) => BigInt(await call(vault, "free", [], block)),
    vaultFor: (factory, owner, block) => call(factory, "vaultFor", [owner], block),
    usdcBalance: async (usdc, who, block) => BigInt(await call(usdc, "balanceOf", [who], block)),
    authorizationUsed: (usdc, who, nonce, block) => call(usdc, "authorizationState", [who, nonce], block),
    receipt: (txHash) => canonicalReceipt(rpc, txHash),
    finality: (rc) => receiptFinality(rpc, rc),
    async getLogs({ address, topics, fromBlock }) {
      const logs = await rpc("eth_getLogs", [{ address, topics, fromBlock: toQty2(fromBlock), toBlock: "latest" }]);
      if (!Array.isArray(logs)) fail("rpc_logs", "eth_getLogs did not return an array");
      return logs;
    }
  });
}
function normState(s, live, apps) {
  return Object.freeze({
    live: Boolean(live),
    state: Number(s.state),
    keyHash: lower(s.keyHash),
    measurement: lower(s.measurement),
    actions: BigInt(s.actions),
    expiresAt: BigInt(s.expiresAt),
    envs: Number(s.envs),
    anyApp: Boolean(s.anyApp),
    balance6: BigInt(s.balance6),
    spent6: BigInt(s.spent6),
    perPeriod6: BigInt(s.perPeriod6),
    maxFee6: BigInt(s.maxFee6),
    maxAppFeeHour6: BigInt(s.maxAppFeeHour6),
    maxRateHour6: BigInt(s.maxRateHour6),
    period: Number(s.period),
    opsPerPeriod: Number(s.opsPerPeriod),
    periodSpent6: BigInt(s.periodSpent6),
    apps: Object.freeze([...apps ?? []].map(lower))
  });
}
function actionsMaskV1(S, names) {
  let m = 0n;
  for (const a of names) {
    if (!Object.prototype.hasOwnProperty.call(S.ACTIONS, a)) fail("legacy_action_unknown", `action ${a} is not a v1 action`);
    m |= 1n << BigInt(S.ACTIONS[a]);
  }
  return m;
}
var envMask = (envs) => envs.reduce((m, e) => m | ({ staging: 1, prod: 2 }[e] ?? fail("legacy_env_unknown", `environment ${e}`)), 0);
var HEX32_CANON = /^0x[0-9a-f]{64}$/;
function appScopeOf(apps) {
  if (!Array.isArray(apps)) fail("legacy_apps_malformed", "grant.apps must be an array");
  if (apps.length === 0) return Object.freeze({ anyApp: false, ids: Object.freeze([]) });
  if (apps.some((a) => typeof a !== "string")) fail("legacy_apps_malformed", "grant.apps must be strings");
  if (apps.includes("*")) {
    if (apps.length !== 1) fail("legacy_apps_malformed", `"*" must be the only entry of a wildcard scope`, { apps: [...apps] });
    return Object.freeze({ anyApp: true, ids: Object.freeze([]) });
  }
  const bad = apps.filter((a) => !HEX32_CANON.test(a));
  if (bad.length) fail("legacy_apps_unverifiable", `app entries [${bad}] need an on-chain resolution this client does not prove; STOP`, { bad });
  if (new Set(apps).size !== apps.length) fail("legacy_apps_malformed", "grant.apps lists an app twice");
  return Object.freeze({ anyApp: false, ids: Object.freeze([...apps]) });
}
function compareGrantToChain(S, g, st, what) {
  const scope = appScopeOf(g.apps);
  const want = {
    keyHash: lower(g.sessionKey),
    measurement: lower(g.measurement),
    actions: actionsMaskV1(S, g.actions),
    expiresAt: BigInt(g.expiresAt),
    envs: envMask(g.environments),
    perPeriod6: BigInt(g.spendPerPeriod),
    maxFee6: BigInt(g.maxFeePerOp),
    maxAppFeeHour6: BigInt(g.maxAppFeePerHour),
    maxRateHour6: BigInt(g.maxRatePerHour),
    period: Number(g.periodSeconds),
    opsPerPeriod: Number(g.opsPerPeriod),
    anyApp: scope.anyApp
  };
  const diff = Object.keys(want).filter((k) => want[k] !== st[k]);
  if (canon([...st.apps]) !== canon([...scope.ids])) diff.push("apps");
  if (diff.length) fail("legacy_fields_mismatch", `${what}: grant differs from chain in [${diff}]`, { diff });
}
function v1GrantFromJson(j) {
  const keys = Object.keys(j).sort();
  if (canon(keys) !== canon([...V1_GRANT_FIELDS].sort())) fail("legacy_grant_shape", `grant fields are [${keys}]`);
  const g = { ...j, actions: [...j.actions], apps: [...j.apps], environments: [...j.environments] };
  for (const k of V1_BIG) g[k] = BigInt(j[k]);
  for (const k of V1_NUM) g[k] = Number(j[k]);
  return g;
}
function orderOf(plan) {
  const o = plan?.terms?.order;
  if (!Array.isArray(o) || o.length < 3 || o[0] !== "terminate" || o[1] !== "legacyOpen" || !o.slice(2).every(isGasStep) || new Set(o).size !== o.length) fail("plan_shape", "the plan's step order is malformed");
  return o;
}
var gasStepsOf = (plan) => orderOf(plan).slice(2);
function partOf(plan, k) {
  const p = plan.terms.gas.parts.find((x) => x.step === k);
  if (!p) fail("plan_shape", `no gas part for ${k}`);
  return p;
}
async function loadLegacyEvidence({ S, legacyStore, sid, owner, chain, legacyConfig, runtime, now }) {
  const o = parseAddress(owner, "owner");
  const id = parseHex32(lower(sid), "sid", { nonZero: true });
  const rec = await legacyStore.load(id);
  if (!rec) fail("legacy_record_missing", `no persisted SDK record ${id} in this origin's IndexedDB; STOP - grant fields cannot be reproduced`);
  if (rec.v !== 1 || !rec.handle || lower(rec.handle.sid) !== id || !rec.grant) fail("legacy_record_shape", "record is not an open v1 session with its grant");
  if (rec.pkcs8 !== void 0) fail("legacy_record_secret", "browser records never hold exportable key bytes");
  if (!rec.privateKey || rec.privateKey.extractable !== false) fail("legacy_key_unusable", "the legacy key is not a non-extractable CryptoKey");
  if (!sameAddr(rec.handle.owner, o)) fail("legacy_owner_mismatch", "record belongs to another owner");
  if (Number(rec.chainId) !== CHAIN_ID || Number(rec.handle.chainId) !== CHAIN_ID) fail("chain_mismatch", "legacy record is not Base 8453");
  const g = rec.grant;
  const keys = Object.keys(g).sort();
  if (canon(keys) !== canon([...V1_GRANT_FIELDS].sort())) fail("legacy_grant_shape", `grant fields are [${keys}]`);
  if (keyHashOf(BigInt(rec.x), BigInt(rec.y)) !== lower(rec.keyHash) || lower(g.sessionKey) !== lower(rec.keyHash)) {
    fail("key_hash_mismatch", "record public key, key hash and grant.sessionKey disagree");
  }
  const vault = parseAddress(rec.handle.vault, "handle.vault");
  if (lower(S.sessionIdOf(vault, g.sessionKey, g.grantNonce)) !== id) fail("legacy_sid_mismatch", "sid is not derived from the persisted grant");
  const factory = parseAddress(legacyConfig.factory, "legacy relay config.factory");
  if (Number(legacyConfig.chainId) !== CHAIN_ID) fail("chain_mismatch", "legacy relay is not Base");
  if (!sameAddr(factory, runtime.pins.legacyFactory)) fail("legacy_factory_mismatch", "legacy relay factory differs from the successor's pinned legacyFactory");
  if (!sameAddr(runtime.cfg.legacyVault, vault)) fail("legacy_vault_mismatch", "successor config legacyVault differs from the record's vault");
  const pin = await chain.pin(now);
  if (!sameAddr(await chain.vaultFor(factory, o, pin.tag), vault)) fail("legacy_vault_mismatch", "factory.vaultFor(owner) is not the record's vault");
  if (!sameAddr(await chain.owner(vault, pin.tag), o)) fail("legacy_owner_mismatch", "vault.owner() is not the connected owner");
  const st = await chain.sessionOf(vault, id, pin.tag);
  if (!st.live) fail("legacy_not_live", "the old session is not live (ended, revoked or expired); STOP");
  compareGrantToChain(S, g, st, "old session");
  if (st.spent6 !== 0n || st.periodSpent6 !== 0n || st.balance6 !== BigInt(g.budget)) {
    fail("legacy_state_changed", `balance ${st.balance6} / spent ${st.spent6} is not the untouched ${g.budget}; STOP`, { balance6: st.balance6, spent6: st.spent6 });
  }
  const free6 = await chain.free(vault, pin.tag);
  await pin.recheck();
  return Object.freeze({
    record: rec,
    grant: g,
    vault,
    sid: id,
    owner: o,
    factory,
    state: st,
    free6,
    observed: Object.freeze({ block: Number(pin.number), hash: pin.hash, timestamp: Number(pin.timestamp) })
  });
}
function parseSplit(split2, scope, fresh6) {
  const T = GAS_GRANT_CANDIDATE;
  if (!split2 || split2.legacy6 === void 0 || split2.gas6 === void 0 && split2.gas === void 0) fail("split_required", "the split is an explicit plan field");
  if (split2.gas6 !== void 0 && split2.gas !== void 0) fail("split_shape", "give gas6 (one grant) OR gas[] (a partition), not both");
  const legacy6 = parseUint(split2.legacy6, 128, "split.legacy6");
  let parts;
  if (split2.gas !== void 0) {
    if (!Array.isArray(split2.gas) || split2.gas.length === 0) fail("split_shape", "gas[] must list the parts");
    parts = split2.gas.map((p, i) => {
      if (p === null || typeof p !== "object" || canon(Object.keys(p).sort()) !== canon(["appIds", "budget6", "name", "opsPerPeriod"])) {
        fail("split_shape", `gas[${i}] must be exactly { name, budget6, opsPerPeriod, appIds }`);
      }
      if (typeof p.name !== "string" || !PART_NAME.test(p.name)) fail("split_shape", `gas[${i}].name must match ${PART_NAME}`);
      if (!Array.isArray(p.appIds) || p.appIds.length === 0 || p.appIds.length > MAX_GRANT_APPS2) {
        fail("gas_part_apps", `gas[${i}] must name 1..${MAX_GRANT_APPS2} explicit app ids (no wildcard)`);
      }
      const appIds = p.appIds.map((a, j) => parseHex32(lower(a), `gas[${i}].appIds[${j}]`, { nonZero: true })).sort();
      if (new Set(appIds).size !== appIds.length) fail("gas_part_apps", `gas[${i}] lists an app twice`);
      const ops = parseUint(p.opsPerPeriod, 32, `gas[${i}].opsPerPeriod`);
      if (ops === 0n) fail("gas_part_ops", `gas[${i}].opsPerPeriod must be positive`);
      return { name: p.name, step: `gasOpen:${p.name}`, budget6: parseUint(p.budget6, 128, `gas[${i}].budget6`), opsPerPeriod: ops, appIds };
    });
    if (new Set(parts.map((p) => p.name)).size !== parts.length) fail("split_shape", "gas part names must be distinct");
  } else {
    if (scope.appIds.length > MAX_GRANT_APPS2) {
      fail("gas_partition_required", `${scope.appIds.length} apps exceed ${MAX_GRANT_APPS2} per grant; name an explicit partition (gas[])`, { byApp: scope.byApp });
    }
    parts = [{
      name: "gas",
      step: "gasOpen",
      budget6: parseUint(split2.gas6, 128, "split.gas6"),
      opsPerPeriod: T.opsPerPeriod,
      appIds: [...scope.appIds].map(lower),
      whole: true
    }];
  }
  const gasTotal = parts.reduce((s, p) => s + p.budget6, 0n);
  if (legacy6 === 0n || parts.some((p) => p.budget6 === 0n)) fail("split_zero", "every part must be positive");
  if (legacy6 + gasTotal !== fresh6) fail("split_total", `legacy ${legacy6} + gas ${gasTotal} must equal the fresh old balance ${fresh6}`);
  if (fresh6 > MAX_COMBINED6) fail("split_total", "combined budget may not exceed 30 USDC");
  if (gasTotal !== T.budget) fail("gas_budget_not_candidate", `gas parts total ${gasTotal}; they must total exactly the reviewed ${T.budget} (never duplicated or enlarged)`);
  if (parts.some((p) => p.budget6 > T.budget)) fail("gas_part_budget", "no gas part may exceed the reviewed budget");
  const opsTotal = parts.reduce((s, p) => s + p.opsPerPeriod, 0n);
  if (opsTotal > T.opsPerPeriod) fail("gas_part_ops", `gas parts allow ${opsTotal} ops per period in total; the candidate is ${T.opsPerPeriod}`);
  const all = parts.flatMap((p) => p.appIds);
  if (new Set(all).size !== all.length) fail("gas_scope_overlap", "an app is named by two gas parts (budget would be duplicated)");
  const scopeSet = new Set(scope.appIds.map(lower));
  const excess = all.filter((a) => !scopeSet.has(a));
  if (excess.length) fail("gas_scope_excess", `apps outside the fresh recovery scope: [${excess}]`, { excess });
  const uncovered = [...scopeSet].filter((a) => !all.includes(a));
  if (uncovered.length) fail("gas_scope_uncovered", `apps of the fresh recovery scope no part covers: [${uncovered}]`, { uncovered });
  return { legacy6, parts, gasTotal };
}
var strip = (g, ks) => Object.fromEntries(Object.entries(jsonable(g)).filter(([k]) => !ks.includes(k)));
function legacyReview(S, terms, n, rng) {
  const tpl = terms.legacy.grantTemplate;
  const grant = v1GrantFromJson({ ...tpl, budget: terms.split.legacy6, grantNonce: randomHex32(rng), signBefore: String(n + SIGN_WINDOW) });
  const vault = terms.legacy.vault;
  return {
    grant: jsonable(grant),
    digest: lower(S.grantDigest(CHAIN_ID, vault, grant)),
    sid: lower(S.sessionIdOf(vault, grant.sessionKey, grant.grantNonce))
  };
}
function terminateReview(S, terms, n, rng) {
  const message = { sessionId: terms.legacy.oldSid, opNonce: randomHex32(rng), signBefore: n + OWNER_OP_WINDOW };
  return { message: jsonable(message), digest: lower(S.digestOf(CHAIN_ID, terms.legacy.vault, "Terminate", message)) };
}
var gasReviewJson = (built, recordId) => ({
  grant: grantBody(built),
  digest: lower(built.digest),
  sid: lower(built.sessionId),
  recordId,
  keyHash: lower(built.typedData.message.sessionKey)
});
async function buildMigrationPlan({ S, evidence, runtime, scope, split: split2, now, rng, subtle, gasStore, relayBase, gasExpiresAt }) {
  const fresh6 = evidence.state.balance6;
  const sp = parseSplit(split2, scope, fresh6);
  if (!runtime.intake?.openEnabled) fail("intake_off", "successor open intake is off; no plan is built");
  const n = BigInt(now);
  const old = evidence.grant;
  if (BigInt(old.expiresAt) <= n + SIGN_WINDOW) fail("legacy_expiring", "the old grant expires inside the signing window");
  const id = `migration:${evidence.sid}`;
  const prior = await gasStore.getJournal(id);
  if (prior && Object.values(prior.steps ?? {}).some((s) => s.status !== "planned")) {
    fail("migration_in_progress", "a migration for this sid already has admitted steps; reconcile it, never re-plan over it");
  }
  const gas = [];
  for (const p of sp.parts) {
    const built = await prepareGasOpen({
      runtime,
      store: gasStore,
      relayBase,
      appIds: p.appIds,
      legacyExpiresAt: old.expiresAt,
      expiresAt: gasExpiresAt ?? old.expiresAt,
      now: n,
      subtle,
      rng,
      signBefore: n + SIGN_WINDOW,
      label: p.whole ? "Gas recovery" : `Gas recovery \xB7 ${p.name}`,
      part: { budget6: p.budget6, opsPerPeriod: p.opsPerPeriod }
    });
    gas.push({ p, ...built });
  }
  const keys = [lower(old.sessionKey), ...gas.map((x) => lower(x.record.keyHash))];
  if (new Set(keys).size !== keys.length) fail("key_reuse", "every gas part needs its own fresh key, distinct from the legacy key");
  const order = ["terminate", "legacyOpen", ...sp.parts.map((p) => p.step)];
  const terms = jsonable({
    schema: MIGRATION_SCHEMA,
    chainId: CHAIN_ID,
    owner: evidence.owner,
    order,
    notes: STEP_NOTES,
    legacy: {
      factory: evidence.factory,
      vault: evidence.vault,
      oldSid: evidence.sid,
      oldBalance6: fresh6,
      oldSpent6: 0n,
      keyHash: lower(old.sessionKey),
      grantTemplate: strip(old, REPLACED_FIELDS)
    },
    split: {
      legacy6: sp.legacy6,
      gas6: sp.gasTotal,
      parts: sp.parts.map((p) => ({ name: p.name, budget6: p.budget6 })),
      total6: fresh6,
      max6: MAX_COMBINED6
    },
    gas: {
      factory: runtime.cfg.factory,
      implementation: runtime.cfg.implementation,
      vault: runtime.cfg.vault,
      usdc: runtime.pins.usdc,
      appIds: [...scope.appIds],
      deployments: [...scope.deployments.keys()].sort(),
      parts: gas.map(({ p, review }) => ({
        name: p.name,
        step: p.step,
        budget6: p.budget6,
        opsPerPeriod: p.opsPerPeriod,
        appIds: p.appIds,
        grantTemplate: strip(review.typedData.message, GAS_VOLATILE)
      }))
    }
  });
  const steps = {
    terminate: { status: "planned", attempt: 1, review: terminateReview(S, terms, n, rng), history: [] },
    legacyOpen: { status: "planned", attempt: 1, review: legacyReview(S, terms, n, rng), history: [] }
  };
  for (const { p, record, review } of gas) steps[p.step] = { status: "planned", attempt: 1, review: gasReviewJson(review, record.id), history: [] };
  const plan = {
    id,
    kind: "migration",
    v: 3,
    rev: 1,
    termsHash: hashOf(terms),
    terms,
    at: Number(n),
    observed: { evidence: evidence.observed, scope: { block: Number(scope.block), hash: scope.blockHash ?? null } },
    steps
  };
  await gasStore.casJournal(id, (cur) => {
    if (cur && Object.values(cur.steps ?? {}).some((s) => s.status !== "planned")) fail("migration_in_progress", "another tab admitted a step meanwhile");
    return plan;
  });
  return plan;
}
function checkTerms(plan, approval) {
  if (!approval || approval.rootReviewed !== true || approval.termsHash !== plan.termsHash || hashOf(plan.terms) !== plan.termsHash) {
    fail("approval_required", `no root-reviewed approval for terms ${plan.termsHash}; nothing was signed`);
  }
}
function replacementFromJournal(S, plan) {
  const r = plan.steps.legacyOpen.review;
  const g = v1GrantFromJson(r.grant);
  const tpl = plan.terms.legacy.grantTemplate;
  const diff = Object.keys(tpl).filter((k) => canon(jsonable({ v: g[k] })) !== canon({ v: tpl[k] }));
  if (diff.length || String(g.budget) !== plan.terms.split.legacy6) fail("review_not_terms", `replacement differs from the reviewed terms in [${diff}]`);
  if (lower(S.grantDigest(CHAIN_ID, plan.terms.legacy.vault, g)) !== r.digest) fail("review_digest_mismatch", "replacement grant does not hash to its digest");
  if (lower(S.sessionIdOf(plan.terms.legacy.vault, g.sessionKey, g.grantNonce)) !== r.sid) fail("review_digest_mismatch", "replacement sid mismatch");
  return g;
}
function terminateFromJournal(S, plan) {
  const r = plan.steps.terminate.review;
  const m = {
    sessionId: parseHex32(r.message.sessionId, "sessionId", { nonZero: true }),
    opNonce: r.message.opNonce,
    signBefore: BigInt(r.message.signBefore)
  };
  if (m.sessionId !== plan.terms.legacy.oldSid) fail("review_not_terms", "Terminate names another session");
  if (lower(S.digestOf(CHAIN_ID, plan.terms.legacy.vault, "Terminate", m)) !== r.digest) fail("review_digest_mismatch", "Terminate does not hash to its digest");
  return m;
}
function gasFromJournal(plan, k, runtime, now) {
  const r = plan.steps[k].review;
  const part = partOf(plan, k);
  const built = rebuildGasReview(runtime.cfg, r.grant, r.digest, now);
  const msg = strip(built.typedData.message, GAS_VOLATILE);
  if (canon(msg) !== canon(part.grantTemplate) || lower(built.sessionId) !== r.sid || lower(built.typedData.message.sessionKey) !== r.keyHash) {
    fail("review_not_terms", `${k}: gas grant differs from the reviewed terms`);
  }
  if (BigInt(built.typedData.message.budget) !== BigInt(part.budget6)) fail("review_not_terms", `${k}: budget differs from its part`);
  if (!sameAddr(runtime.cfg.vault, plan.terms.gas.vault)) fail("review_not_terms", "runtime vault differs from the reviewed one");
  return built;
}
async function signSteps({ S, plan, steps, approval, provider, rpc, runtime, now }) {
  checkTerms(plan, approval);
  const n = BigInt(now);
  const order = orderOf(plan);
  const pending = order.filter((k) => plan.steps[k].status !== "proven");
  if (!Array.isArray(steps) || steps.length === 0 || steps.some((k) => !pending.includes(k))) fail("sign_steps", "sign only steps that are not proven");
  if (steps.join() !== pending.slice(0, steps.length).join()) fail("sign_steps", "sign the NEXT steps in order, without gaps");
  if (steps.includes("terminate") && !steps.includes("legacyOpen")) fail("sign_steps", "the original is only touched once its replacement is signed");
  for (const k of steps) if (plan.steps[k].status !== "planned") fail("step_not_planned", `${k} is ${plan.steps[k].status}; reconcile it`);
  const owner = plan.terms.owner;
  const vault = plan.terms.legacy.vault;
  const out = {};
  for (const k of steps) {
    if (k === "terminate") {
      const m = terminateFromJournal(S, plan);
      if (n >= m.signBefore) fail("sign_window_passed", "Terminate window closed; rearm it");
      const sig = await walletSignTyped(provider, owner, S.typedData(CHAIN_ID, vault, "Terminate", m));
      out.terminate = { digest: plan.steps.terminate.review.digest, body: { owner, vault, op: "terminate", args: m, sig } };
    } else if (k === "legacyOpen") {
      const g = replacementFromJournal(S, plan);
      if (n >= g.signBefore) fail("sign_window_passed", "replacement window closed; rearm it");
      const ownerSig = await walletSignTyped(provider, owner, S.typedData(CHAIN_ID, vault, "SessionGrant", g));
      const dep = depositTypedData(await usdcDomain(rpc, plan.terms.gas.usdc), {
        from: owner,
        to: vault,
        value: g.budget,
        nonce: plan.steps.legacyOpen.review.digest,
        validBefore: g.signBefore
      });
      const depSig = await walletSignTyped(provider, owner, dep);
      out.legacyOpen = {
        digest: plan.steps.legacyOpen.review.digest,
        body: { owner, grant: g, ownerSig, deposit: { validAfter: 0n, validBefore: g.signBefore, sig: depSig } }
      };
    } else {
      const built = gasFromJournal(plan, k, runtime, n);
      const body = await signGasOpen({
        runtime,
        provider,
        rpc,
        review: built,
        now: n,
        approval: { rootReviewed: true, digest: plan.steps[k].review.digest }
      });
      out[k] = { digest: plan.steps[k].review.digest, body };
    }
  }
  return Object.freeze(out);
}
var stepEvent = (plan, k) => k === "terminate" ? { address: plan.terms.legacy.vault, topics: encodeEventTopics({ abi: VAULT_EVENTS, eventName: "SessionEnded", args: { sid: plan.terms.legacy.oldSid } }) } : {
  address: k === "legacyOpen" ? plan.terms.legacy.vault : plan.terms.gas.vault,
  topics: encodeEventTopics({ abi: VAULT_EVENTS, eventName: "SessionOpened", args: { sid: plan.steps[k].review.sid } })
};
async function proveStep(ctx, plan, k, txHash) {
  const { S, chain } = ctx;
  const rc = await chain.receipt(txHash);
  if (!rc) return null;
  const owner = plan.terms.owner;
  const usdc = plan.terms.gas.usdc;
  if (k === "terminate") {
    proveEnded(rc, { vault: plan.terms.legacy.vault, usdc, owner, sid: plan.terms.legacy.oldSid, refund6: BigInt(plan.terms.legacy.oldBalance6) });
  } else if (k === "legacyOpen") {
    const g = replacementFromJournal(S, plan);
    proveOpened(rc, {
      vault: plan.terms.legacy.vault,
      usdc,
      owner,
      sid: plan.steps.legacyOpen.review.sid,
      keyHash: plan.terms.legacy.keyHash,
      digest: plan.steps.legacyOpen.review.digest,
      amount6: g.budget,
      expiresAt: g.expiresAt,
      actions: actionsMaskV1(S, g.actions),
      envs: envMask(g.environments)
    });
    compareGrantToChain(S, g, await chain.sessionOf(plan.terms.legacy.vault, plan.steps.legacyOpen.review.sid), "replacement");
  } else {
    const r = plan.steps[k].review;
    const part = partOf(plan, k);
    if (BigInt(r.grant.budget) !== BigInt(part.budget6)) fail("review_not_terms", `${k}: journal budget differs from its part`);
    proveOpened(rc, {
      vault: plan.terms.gas.vault,
      usdc,
      owner,
      sid: r.sid,
      keyHash: r.keyHash,
      digest: r.digest,
      amount6: BigInt(part.budget6),
      expiresAt: BigInt(r.grant.expiresAt),
      actions: 1n << 10n,
      envs: 3
    });
  }
  const fin = chain.finality ? await chain.finality(rc) : { final: false };
  return { txHash: lower(txHash), block: Number(BigInt(rc.blockNumber)), blockHash: lower(rc.blockHash), final: Boolean(fin.final) };
}
var acceptable = (ctx, proof) => proof && (!ctx.requireFinal || proof.final) ? proof : null;
function finalityPolicy(p) {
  if (p === void 0 || p === null) return null;
  if (typeof p !== "object" || canon(Object.keys(p).sort()) !== canon(["cacheFinalized", "reviewedBy", "source"]) || p.cacheFinalized !== true || p.source !== "finalized-tag" || typeof p.reviewedBy !== "string" || p.reviewedBy.length === 0) {
    fail("finality_policy_invalid", 'finality policy must be exactly { cacheFinalized: true, source: "finalized-tag", reviewedBy }');
  }
  return p;
}
async function recheckProven(ctx, planId, plan, k) {
  const st = plan.steps[k];
  if (st.status !== "proven" || !st.proof || !st.txHash) fail("previous_unproven", `${k} is ${st.status}`);
  if (finalityPolicy(ctx.finalityPolicy) && st.proof.final === true) return;
  let proof = null;
  let why = null;
  try {
    proof = await proveStep(ctx, plan, k, st.txHash);
  } catch (e) {
    why = `contradiction:${e?.code ?? "error"}`;
  }
  if (!why && !proof) why = "lost";
  if (!why && (proof.block !== st.proof.block || proof.blockHash !== st.proof.blockHash)) why = "moved";
  if (why) {
    await cas(ctx, planId, k, (s) => {
      s.recheck = { at: Number(ctx.now), result: why };
    });
    fail(
      why === "lost" ? "prior_proof_lost" : why === "moved" ? "prior_proof_changed" : "prior_proof_contradiction",
      `${k}: its proven receipt no longer holds at block ${st.proof.block} (${why}); nothing is sent or adopted - reconcile once the chain settles, or review`
    );
  }
  if (proof.final && !st.proof.final || st.recheck) {
    await cas(ctx, planId, k, (s) => {
      s.proof.final = s.proof.final || proof.final;
      delete s.recheck;
    });
  }
}
async function recheckPrior(ctx, planId, plan, k) {
  const order = orderOf(plan);
  for (const p of order.slice(0, order.indexOf(k))) await recheckProven(ctx, planId, await ctx.gasStore.getJournal(planId), p);
}
async function adoptReplacement(ctx, plan) {
  const { S, legacyStore, setActive, now } = ctx;
  const old = await legacyStore.load(plan.terms.legacy.oldSid);
  if (!old || lower(old.keyHash) !== plan.terms.legacy.keyHash) fail("legacy_record_lost", "the original record (holding the key) is missing; STOP");
  const g = replacementFromJournal(S, plan);
  const sid = plan.steps.legacyOpen.review.sid;
  const existing = await legacyStore.load(sid);
  if (existing && lower(existing.keyHash) !== plan.terms.legacy.keyHash) fail("record_collision", "another record uses the replacement sid");
  if (!existing) {
    await legacyStore.save({ ...old, id: sid, grant: g, createdAt: Number(now), handle: { ...old.handle, sid } });
  }
  const kept = await legacyStore.load(old.id);
  if (!kept || kept.keyHash !== old.keyHash) fail("legacy_record_lost", "the old record must survive the migration");
  if (typeof setActive === "function") await setActive(sid, plan.terms.legacy.oldSid);
  return sid;
}
async function adoptGas(ctx, plan, k, proof) {
  const r = plan.steps[k].review;
  const rec = await ctx.gasStore.loadKey(r.recordId);
  if (!rec || lower(rec.keyHash) !== r.keyHash) fail("gas_record_lost", `${k}: the gas key record is missing`);
  if (rec.status === "open" && lower(rec.sid) === r.sid) return;
  Object.assign(rec, { status: "open", sid: r.sid, grant: r.grant, grantDigest: r.digest, open: { txHash: proof.txHash, block: proof.block } });
  await ctx.gasStore.saveKey(rec);
}
async function afterProven(ctx, plan, k, proof) {
  if (k === "legacyOpen") await adoptReplacement(ctx, plan);
  else if (isGasStep(k)) await adoptGas(ctx, plan, k, proof);
}
function cas(ctx, id, k, fn) {
  return ctx.gasStore.casJournal(id, (cur) => {
    if (!cur) fail("plan_missing", "no journaled plan");
    if (!cur.steps[k]) fail("plan_shape", `no step ${k}`);
    fn(cur.steps[k], cur);
    cur.rev = Number(cur.rev ?? 0) + 1;
    return cur;
  });
}
var admit = (ctx, id, k, digest, observed) => cas(ctx, id, k, (st, cur) => {
  if (st.status !== "planned" || st.review.digest !== digest) fail("step_not_planned", `${k} is ${st.status} (or was re-armed); nothing sent`);
  const order = orderOf(cur);
  for (const p of order.slice(0, order.indexOf(k))) if (cur.steps[p].status !== "proven" || cur.steps[p].recheck) fail("previous_unproven", `${p} is not (still) proven`);
  Object.assign(st, { status: "admitted", admittedAt: Number(ctx.now), observed });
});
var noteSubmitted = (ctx, id, k, txHash) => cas(ctx, id, k, (st) => {
  if (st.status !== "admitted" && !(st.status === "submitted" && st.txHash === txHash)) fail("step_state", `${k} is ${st.status}`);
  Object.assign(st, { status: "submitted", txHash });
});
var noteError = (ctx, id, k, code) => cas(ctx, id, k, (st) => {
  st.lastError = String(code ?? "error");
});
var markProven = (ctx, id, k, proof) => cas(ctx, id, k, (st) => {
  if (st.status === "proven") return;
  if (st.status !== "admitted" && st.status !== "submitted") fail("step_state", `${k} is ${st.status}`);
  Object.assign(st, { status: "proven", txHash: proof.txHash, proof: { block: proof.block, blockHash: proof.blockHash, final: proof.final } });
});
async function preconditions(ctx, planId, plan, k) {
  const { S, chain, legacyStore, gasStore } = ctx;
  await recheckPrior(ctx, planId, plan, k);
  const T = plan.terms;
  const pin = await chain.pin(ctx.now);
  const used = (d) => chain.authorizationUsed(T.gas.usdc, T.owner, d, pin.tag);
  if (k === "terminate") {
    const old = await legacyStore.load(T.legacy.oldSid);
    if (!old || lower(old.keyHash) !== T.legacy.keyHash) fail("legacy_record_lost", "original record missing; the original stays untouched");
    const st = await chain.sessionOf(T.legacy.vault, T.legacy.oldSid, pin.tag);
    if (!st.live || st.balance6 !== BigInt(T.legacy.oldBalance6) || st.spent6 !== 0n) fail("legacy_state_changed", "the old session changed since the plan; STOP");
    compareGrantToChain(S, old.grant, st, "old session");
    if (await used(plan.steps.legacyOpen.review.digest)) fail("legacy_auth_used", "replacement authorization already used");
  } else if (k === "legacyOpen") {
    if (!await legacyStore.load(T.legacy.oldSid)) fail("legacy_record_lost", "original record (the key) missing; not opening");
    if ((await chain.sessionOf(T.legacy.vault, plan.steps.legacyOpen.review.sid, pin.tag)).state !== 0) fail("replacement_exists", "replacement sid already exists; reconcile");
    if (await used(plan.steps.legacyOpen.review.digest)) fail("legacy_auth_used", "replacement authorization already used; reconcile");
    if (await chain.usdcBalance(T.gas.usdc, T.owner, pin.tag) < BigInt(T.split.legacy6)) fail("owner_balance_short", "owner wallet lacks the replacement amount");
  } else {
    if (!ctx.runtime.intake?.openEnabled) fail("intake_off", "successor open intake is off");
    const r = plan.steps[k].review;
    const rec = await gasStore.loadKey(r.recordId);
    if (!rec || lower(rec.keyHash) !== r.keyHash) fail("gas_record_lost", `${k}: gas key record missing`);
    if (await used(r.digest)) fail("gas_auth_used", `${k}: gas authorization already used; reconcile`);
    if (await chain.usdcBalance(T.gas.usdc, T.owner, pin.tag) < BigInt(partOf(plan, k).budget6)) fail("owner_balance_short", `${k}: owner wallet lacks this part's amount`);
  }
  await pin.recheck();
  return { block: Number(pin.number), hash: pin.hash, timestamp: Number(pin.timestamp) };
}
function send(ctx, k, body) {
  if (k === "terminate") return ctx.legacyRelay.request("POST", "/owner", body);
  if (k === "legacyOpen") return ctx.legacyRelay.request("POST", "/open", body);
  return ctx.relay("POST", "/funding/open", body);
}
async function runMigration(ctx, planId, signed) {
  for (; ; ) {
    const plan = await ctx.gasStore.getJournal(planId);
    if (!plan) fail("plan_missing", "no journaled plan");
    const order = orderOf(plan);
    const k = order.find((s) => plan.steps[s].status !== "proven");
    if (!k) return { done: true, steps: statusOf(plan) };
    const st = plan.steps[k];
    if (st.status !== "planned") return { stage: k, needsReconcile: true, steps: statusOf(plan) };
    const sg = signed?.[k];
    if (!sg || lower(sg.digest) !== st.review.digest) return { stage: k, needsSignature: true, steps: statusOf(plan) };
    if (k === "terminate" && signed?.legacyOpen?.digest !== plan.steps.legacyOpen.review.digest) {
      fail("replacement_unsigned", "the original is only terminated with its replacement already signed");
    }
    const observed = await preconditions(ctx, planId, plan, k);
    await admit(ctx, planId, k, st.review.digest, observed);
    let out;
    try {
      out = await send(ctx, k, sg.body);
    } catch (err) {
      await noteError(ctx, planId, k, err?.code);
      throw err;
    }
    const txHash = typeof out?.txHash === "string" ? lower(out.txHash) : null;
    if (!txHash) return { stage: k, pending: true, steps: statusOf(await ctx.gasStore.getJournal(planId)) };
    await noteSubmitted(ctx, planId, k, txHash);
    if (out.sid !== void 0 && k !== "terminate" && lower(out.sid) !== st.review.sid) {
      await noteError(ctx, planId, k, "relay_sid_mismatch");
      fail("relay_sid_mismatch", `relay reported ${out.sid}, expected ${st.review.sid}`);
    }
    let proof;
    try {
      proof = acceptable(ctx, await proveStep(ctx, await ctx.gasStore.getJournal(planId), k, txHash));
    } catch (err) {
      await noteError(ctx, planId, k, err?.code);
      throw err;
    }
    if (!proof) return { stage: k, pending: true, txHash, steps: statusOf(await ctx.gasStore.getJournal(planId)) };
    await markProven(ctx, planId, k, proof);
    await recheckPrior(ctx, planId, plan, k);
    await afterProven(ctx, await ctx.gasStore.getJournal(planId), k, proof);
  }
}
var statusOf = (plan) => Object.fromEntries(orderOf(plan).map((k) => [k, plan.steps[k].status]));
async function notApplied(ctx, plan, k, tag) {
  const { chain } = ctx;
  const T = plan.terms;
  if (k === "terminate") {
    const st = await chain.sessionOf(T.legacy.vault, T.legacy.oldSid, tag);
    return st.live && st.balance6 === BigInt(T.legacy.oldBalance6);
  }
  const r = plan.steps[k].review;
  if (await chain.authorizationUsed(T.gas.usdc, T.owner, r.digest, tag)) return false;
  if (k === "legacyOpen") return (await chain.sessionOf(T.legacy.vault, r.sid, tag)).state === 0;
  return true;
}
var windowOf = (plan, k) => BigInt(k === "terminate" ? plan.steps[k].review.message.signBefore : plan.steps[k].review.grant.signBefore);
async function reconcileMigration(ctx, planId) {
  const report = [];
  const order = orderOf(await ctx.gasStore.getJournal(planId));
  for (const k of order) {
    let plan2 = await ctx.gasStore.getJournal(planId);
    const st = plan2.steps[k];
    if (st.status === "proven") {
      await recheckProven(ctx, planId, plan2, k);
      plan2 = await ctx.gasStore.getJournal(planId);
      await afterProven(ctx, plan2, k, { txHash: st.txHash, block: st.proof.block });
      report.push({ k, status: "proven" });
      continue;
    }
    if (st.status === "planned" || st.status === "void") {
      report.push({ k, status: st.status, next: st.status === "void" || BigInt(ctx.now) >= windowOf(plan2, k) ? "rearm" : "sign" });
      break;
    }
    let hashes = st.txHash ? [st.txHash] : [];
    if (!hashes.length && st.observed) {
      const ev = stepEvent(plan2, k);
      const logs = await ctx.chain.getLogs({ address: ev.address, topics: ev.topics, fromBlock: st.observed.block });
      hashes = [...new Set(logs.filter((l) => l.removed !== true).map((l) => lower(l.transactionHash)))];
    }
    let proof = null;
    let reverted = 0;
    for (const h of hashes) {
      try {
        proof = acceptable(ctx, await proveStep(ctx, plan2, k, h));
      } catch (e) {
        if (e?.code === "tx_reverted") {
          reverted += 1;
          continue;
        }
        throw e;
      }
      if (proof) break;
    }
    if (proof) {
      if (!st.txHash) await noteSubmitted(ctx, planId, k, proof.txHash);
      await markProven(ctx, planId, k, proof);
      await recheckPrior(ctx, planId, plan2, k);
      await afterProven(ctx, await ctx.gasStore.getJournal(planId), k, proof);
      report.push({ k, status: "proven" });
      continue;
    }
    if (hashes.length > reverted) {
      report.push({ k, status: st.status, next: "wait_canonical" });
      break;
    }
    const w = windowOf(plan2, k);
    const pin = await ctx.chain.pin(ctx.now);
    if (BigInt(pin.timestamp) <= w || BigInt(ctx.now) <= w) {
      report.push({ k, status: st.status, next: "wait_window" });
      break;
    }
    const clean2 = await notApplied(ctx, plan2, k, pin.tag);
    await pin.recheck();
    if (!clean2) fail("step_contradiction", `${k}: chain shows an effect without a provable transaction; STOP for review`);
    await cas(ctx, planId, k, (s) => {
      if (s.status !== st.status || (s.txHash ?? null) !== (st.txHash ?? null)) fail("step_state", `${k} changed meanwhile`);
      s.status = "void";
      s.voidAt = Number(ctx.now);
      s.voidEvidence = { block: Number(pin.number), hash: pin.hash, timestamp: Number(pin.timestamp) };
    });
    report.push({ k, status: "void", next: "rearm" });
    break;
  }
  const plan = await ctx.gasStore.getJournal(planId);
  return { steps: statusOf(plan), report };
}
async function rearmStep(ctx, planId, k) {
  const { S, runtime, rng } = ctx;
  const n = BigInt(ctx.now);
  const plan = await ctx.gasStore.getJournal(planId);
  if (!orderOf(plan).includes(k)) fail("plan_shape", `no step ${k}`);
  const st = plan.steps[k];
  if (st.status !== "void" && st.status !== "planned") fail("step_not_rearmable", `${k} is ${st.status}; reconcile it`);
  let review;
  if (k === "terminate") review = terminateReview(S, plan.terms, n, rng);
  else if (k === "legacyOpen") review = legacyReview(S, plan.terms, n, rng);
  else {
    const old = st.review;
    const part = partOf(plan, k);
    const built = buildGasGrant(runtime.cfg, {
      now: n,
      sessionKey: old.keyHash,
      appIds: part.appIds,
      expiresAt: part.grantTemplate.expiresAt,
      legacyExpiresAt: plan.terms.legacy.grantTemplate.expiresAt,
      grantNonce: randomHex32(rng),
      signBefore: n + SIGN_WINDOW,
      label: part.grantTemplate.label,
      part: { budget6: part.budget6, opsPerPeriod: part.opsPerPeriod }
    });
    if (canon(strip(built.typedData.message, GAS_VOLATILE)) !== canon(part.grantTemplate)) fail("review_not_terms", `${k}: re-armed grant differs from its terms`);
    review = gasReviewJson(built, old.recordId);
    const rec = await ctx.gasStore.loadKey(old.recordId);
    Object.assign(rec, { status: "reviewed", sid: review.sid, grant: review.grant, grantDigest: review.digest });
    await ctx.gasStore.saveKey(rec);
  }
  await cas(ctx, planId, k, (s) => {
    if (s.status !== st.status || s.review.digest !== st.review.digest) fail("step_state", `${k} changed meanwhile`);
    s.history.push({ attempt: s.attempt, digest: s.review.digest, status: s.status, txHash: s.txHash ?? null });
    Object.assign(s, { status: "planned", attempt: s.attempt + 1, review });
    delete s.txHash;
    delete s.observed;
    delete s.lastError;
    delete s.admittedAt;
    delete s.voidAt;
    delete s.voidEvidence;
  });
  return ctx.gasStore.getJournal(planId);
}

// sdk/funding/gas-execution.mjs
var EXEC_SCHEMA = "enclave-funding-gas-execute-r2";
var MAX_DISCOVERY_BLOCKS = 600n;
var MAX_CANDIDATES = 16;
var MAX_PREDECESSORS = 4;
var DEFINITIVE_REFUSALS = Object.freeze({
  400: Object.freeze(["bad_request", "bad_action", "bad_args", "wrong_payer", "fee_tier_not_pinned", "bad_deadline"]),
  402: Object.freeze(["policy_refused"]),
  404: Object.freeze(["not_a_funding_vault", "unknown_deployment"]),
  409: Object.freeze([
    "not_live",
    "op_limit",
    "op_counter_exhausted",
    "nonce_lane_exhausted",
    "quote_exceeds_adapter",
    "expired",
    "quote_moved",
    "vault_identity"
  ])
});
var CLEARED = Object.freeze(["settled", "superseded", "refused", "never_dispatched", "abandoned_before_send", "expired_unused"]);
var EXPIRABLE = Object.freeze(["dispatching", "unknown", "pending", "reverted_observed"]);
var RELEASABLE = Object.freeze(["expired_unused", "refused", "never_dispatched", "abandoned_before_send"]);
var H322 = /^0x[0-9a-f]{64}$/;
var QTY2 = /^0x(0|[1-9a-f][0-9a-f]*)$/;
var DEC = /^(0|[1-9][0-9]*)$/;
var MASK64 = (1n << 64n) - 1n;
var isHash = (h) => typeof h === "string" && H322.test(lower(h)) && !/^0x0{64}$/.test(lower(h));
var normRelay = (r) => String(r ?? "").replace(/\/+$/, "");
var toQty3 = (n) => `0x${BigInt(n).toString(16)}`;
var execId = (sid, nonce) => `gas-exec:${lower(sid)}:${BigInt(nonce)}`;
var EXECUTE_ABI = Object.freeze([{
  type: "function",
  name: "execute",
  stateMutability: "nonpayable",
  inputs: [
    { name: "sid", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "action", type: "uint8" },
    { name: "args", type: "bytes" },
    { name: "fee", type: "uint256" },
    { name: "deadline", type: "uint64" },
    { name: "x", type: "uint256" },
    { name: "y", type: "uint256" },
    { name: "r", type: "bytes32" },
    { name: "sv", type: "bytes32" }
  ],
  outputs: [{ name: "result", type: "bytes" }]
}]);
var SEQ_ABI = Object.freeze([{
  type: "function",
  name: "seqOf",
  stateMutability: "view",
  inputs: [{ name: "", type: "bytes32" }, { name: "", type: "uint192" }],
  outputs: [{ name: "", type: "uint64" }]
}]);
var cloneRuntime = (impl) => `0x363d3d373d3d3d363d73${lower(impl).slice(2)}5af43d82803e903d91602b57fd5bf3`;
function runtimeIdentity(runtime) {
  const c = runtime?.cfg;
  if (!c) fail("runtime_missing", "no verified runtime");
  return {
    chainId: String(c.chainId ?? 8453),
    factory: lower(c.factory),
    implementation: lower(c.implementation),
    gasAdapter: lower(c.gasAdapter ?? ""),
    legacyFactory: lower(c.legacyFactory ?? ""),
    legacyVault: lower(c.legacyVault ?? ""),
    vault: lower(c.vault),
    owner: lower(c.owner),
    usdc: lower(runtime.pins?.usdc ?? "")
  };
}
function recordIdentity(record) {
  return {
    id: String(record.id),
    keyHash: lower(record.keyHash),
    x: BigInt(record.x).toString(),
    y: BigInt(record.y).toString(),
    owner: lower(record.owner),
    vault: lower(record.vault),
    chainId: String(record.chainId),
    relay: normRelay(record.relay),
    sid: lower(record.sid)
  };
}
function requireRecordForRuntime(runtime, record, relayBase) {
  const c = runtime.cfg;
  if (!record || record.status !== "open" || !isHash(record.sid)) fail("session_not_open", "the gas record is not an open session");
  if (keyHashOf(BigInt(record.x), BigInt(record.y)) !== lower(record.keyHash)) fail("key_mismatch", "record public key and key hash disagree");
  if (!sameAddr(record.vault, c.vault) || !sameAddr(record.owner, c.owner) || Number(record.chainId) !== 8453) {
    fail("record_runtime_mismatch", "the gas record belongs to another owner, vault or chain than the verified runtime");
  }
  if (typeof relayBase !== "string" || normRelay(relayBase) !== normRelay(record.relay)) {
    fail("record_relay_mismatch", "the relay used now is not the relay this gas record was opened through");
  }
}
var sameJson = (a, b) => canon(a) === canon(b);
function bindReview(runtime, record, review, now) {
  const c = review?.call;
  if (!c?.execute || !c.intent) fail("review_shape", "the review carries no codec call");
  const rebuilt = buildGasFundCall(runtime.cfg, {
    domainVersion: "2",
    now: BigInt(now),
    sessionId: lower(record.sid),
    nonce: BigInt(c.execute.nonce),
    action: ACTION_GAS_FUND,
    intent: c.intent,
    fee: BigInt(c.execute.fee),
    deadline: BigInt(c.execute.deadline)
  });
  const bad = [];
  if (lower(rebuilt.digest) !== lower(c.digest)) bad.push("digest");
  if (lower(rebuilt.args) !== lower(c.args)) bad.push("args");
  if (lower(rebuilt.argsHash) !== lower(c.argsHash)) bad.push("argsHash");
  if (lower(c.execute.sessionId) !== lower(record.sid)) bad.push("sessionId");
  if (Number(c.execute.action) !== ACTION_GAS_FUND) bad.push("action");
  if (c.typedData && !sameJson(c.typedData.domain, rebuilt.typedData.domain)) bad.push("domain");
  if (review.deployment !== void 0 && lower(review.deployment) !== lower(rebuilt.intent.deployment)) bad.push("deployment");
  if (review.sid !== void 0 && lower(review.sid) !== lower(record.sid)) bad.push("sid");
  const t = review.totals ?? {};
  if (BigInt(t.maxUsdcIn6 ?? -1) !== rebuilt.maximum.maxUsdcIn6 || BigInt(t.fee6 ?? -1) !== rebuilt.maximum.fee6 || BigInt(t.totalMaximum6 ?? -1) !== rebuilt.maximum.totalMaximum6) bad.push("maximum");
  if (bad.length) fail("review_not_bound", `the review differs from its re-derivation in [${bad}]; nothing was signed`, { bad });
  return rebuilt;
}
function intentOf({ runtime, record, relayBase, call, now, anchor }) {
  const i = call.intent;
  return {
    runtime: runtimeIdentity(runtime),
    relayer: lower(runtime.relayer ?? ""),
    record: recordIdentity(record),
    relay: normRelay(relayBase),
    sid: lower(record.sid),
    nonce: BigInt(call.execute.nonce).toString(),
    deployment: lower(i.deployment),
    holder: lower(i.expectedOwner),
    call: {
      domain: {
        name: call.typedData.domain.name,
        version: String(call.typedData.domain.version),
        chainId: String(call.typedData.domain.chainId),
        verifyingContract: lower(call.typedData.domain.verifyingContract)
      },
      digest: lower(call.digest),
      argsHash: lower(call.argsHash),
      args: lower(call.args),
      action: String(ACTION_GAS_FUND),
      nonce: BigInt(call.execute.nonce).toString(),
      lane: BigInt(call.nonce.lane).toString(),
      seq: BigInt(call.nonce.seq).toString(),
      fee: BigInt(call.execute.fee).toString(),
      deadline: BigInt(call.execute.deadline).toString(),
      builtAt: BigInt(now).toString(),
      intent: {
        payer: lower(i.payer),
        deployment: lower(i.deployment),
        expectedOwner: lower(i.expectedOwner),
        ethOut: BigInt(i.ethOut).toString(),
        maxUsdcIn6: BigInt(i.maxUsdcIn6).toString(),
        fee: String(Number(i.fee)),
        deadline: BigInt(i.deadline).toString()
      }
    },
    maximum: { maxUsdcIn6: call.maximum.maxUsdcIn6.toString(), fee6: call.maximum.fee6.toString(), totalMaximum6: call.maximum.totalMaximum6.toString() },
    anchor: { number: anchor.number.toString(), hash: lower(anchor.hash), timestamp: anchor.timestamp.toString() }
  };
}
var INTENT_KEYS = ["runtime", "relayer", "record", "relay", "sid", "nonce", "deployment", "holder", "call", "maximum", "anchor"];
var intentPart = (e) => Object.fromEntries(INTENT_KEYS.map((k) => [k, e[k]]));
function isBlocking(e) {
  if (!e || e.kind !== "gas-execute") return false;
  if (e.schema === EXEC_SCHEMA) return !CLEARED.includes(e.status);
  return e.status !== "settled";
}
function executionBlockers(entries, record) {
  return (entries || []).filter((e) => isBlocking(e) && lower(e.sid) === lower(record.sid) && (e.schema !== EXEC_SCHEMA || e.record?.id === String(record.id)));
}
var hintHashes = (d) => [...new Set([d?.txHash, ...Array.isArray(d?.txHashes) ? d.txHashes : []].filter(isHash).map(lower))];
function classifyExecuteFailure(err) {
  if (err instanceof RelayError && Number.isInteger(err.status) && err.status >= 400 && err.status < 500) {
    const d = err.detail;
    const allowed = DEFINITIVE_REFUSALS[err.status];
    const wellFormed = d && typeof d === "object" && !Array.isArray(d) && d.code === err.code && typeof d.error === "string";
    if (allowed?.includes(err.code) && wellFormed && hintHashes(d).length === 0) {
      return { kind: "refused", code: err.code, status: err.status };
    }
  }
  const phase = err instanceof RelayError ? err.status ? "http_error" : "transport" : err instanceof TypeError ? "body_or_transport" : "unclassified";
  return {
    kind: "unknown",
    code: String(err?.code ?? err?.name ?? "error"),
    status: Number.isInteger(err?.status) ? err.status : null,
    phase,
    hints: hintHashes(err?.detail)
  };
}
var pageGuardCancelled = (err) => !(err instanceof RelayError) && !(err instanceof TypeError) && err?.name === "StateError" && err?.code === "context_changed";
async function transition(store, id, from, mutate) {
  return store.casJournal(id, (cur) => {
    if (!cur || cur.schema !== EXEC_SCHEMA) fail("journal_changed", `${id} is missing or not a ${EXEC_SCHEMA} entry`);
    if (cur.intentHash !== from.intentHash || cur.status !== from.status || Number(cur.rev) !== Number(from.rev)) {
      fail("journal_changed", `${id} changed meanwhile (${cur.status}); nothing was overwritten`);
    }
    const next = mutate(cur) ?? cur;
    next.rev = Number(cur.rev) + 1;
    return next;
  });
}
var addHints = (e, hs) => {
  e.hints = { txHashes: [.../* @__PURE__ */ new Set([...e.hints?.txHashes ?? [], ...hs])].slice(0, MAX_CANDIDATES) };
};
async function confirmGasFund({ runtime, store, record, review, relay, relayBase, rpc, now, subtle, dispatchGuard }) {
  requireRecordForRuntime(runtime, record, relayBase);
  const call = bindReview(runtime, record, review, now);
  const e = call.execute;
  if (BigInt(now) > e.deadline) fail("call_deadline_passed", "the quote expired; quote again");
  const signer = signerFor(record.privateKey, BigInt(record.x), BigInt(record.y), subtle);
  if (signer.keyHash !== lower(record.keyHash)) fail("key_mismatch", "record key hash mismatch");
  const before = executionBlockers(await store.listJournal(), record);
  if (before.length) fail("unreconciled_execute", "an earlier gas.fund of this session is not resolved; reconcile it first (never resent)", { ids: before.map((x) => x.id) });
  const id = execId(record.sid, e.nonce);
  const prior = await store.getJournal(id);
  const release = prior ? await releasePrior(prior, { runtime, store, rpc, relayBase, call }) : null;
  const anchor = await pinBlock(rpc, now);
  const body = intentOf({ runtime, record, relayBase, call, now, anchor });
  const entry = {
    id,
    kind: "gas-execute",
    schema: EXEC_SCHEMA,
    status: "admitted",
    rev: 1,
    at: Number(now),
    ...body,
    intentHash: hashOf(body),
    hints: { txHashes: [] },
    evidence: null,
    outcome: null,
    lastReconcile: null,
    history: []
  };
  if (release) {
    entry.rev = Number(release.prior.rev) + 1;
    entry.predecessors = [...release.prior.predecessors ?? [], predecessorOf(release.prior, release.proof)];
    entry.predecessorsHash = hashOf(entry.predecessors);
  }
  const admitted = await store.casJournal(id, (cur2) => {
    if (!cur2 && !release) return entry;
    const p = release?.prior;
    if (!cur2 || !p || cur2.schema !== EXEC_SCHEMA || cur2.status !== p.status || cur2.intentHash !== p.intentHash || Number(cur2.rev) !== Number(p.rev) || (cur2.predecessorsHash ?? null) !== (p.predecessorsHash ?? null)) {
      fail("execute_exists", `${id} already exists (${cur2?.status ?? "changed"}); never overwritten`);
    }
    return entry;
  });
  const abandon = async (reason) => transition(store, id, admitted, (cur2) => {
    cur2.status = "abandoned_before_send";
    cur2.outcome = { reason };
  });
  const others = executionBlockers(await store.listJournal(), record).filter((x) => x.id !== id);
  if (others.length) {
    await abandon("concurrent_execution");
    fail("concurrent_execution", "another execution of this session was admitted concurrently; nothing was signed or sent", { ids: others.map((x) => x.id) });
  }
  const { r, s } = await signer.signDigest(lower(call.digest));
  if (typeof dispatchGuard === "function") {
    try {
      dispatchGuard();
    } catch (err) {
      await abandon("guard_before_dispatch");
      throw err;
    }
  }
  const dispatching = await transition(store, id, admitted, (cur2) => {
    cur2.status = "dispatching";
  });
  let out;
  try {
    out = await relay("POST", "/funding/execute", {
      vault: runtime.cfg.vault,
      sid: lower(record.sid),
      nonce: e.nonce,
      action: ACTION_GAS_FUND,
      args: e.args,
      fee: e.fee,
      deadline: e.deadline,
      x: signer.x,
      y: signer.y,
      r,
      s
    });
  } catch (err) {
    const c = pageGuardCancelled(err) ? { kind: "not_dispatched", code: "context_changed", status: null, phase: "page_guard_before_fetch" } : classifyExecuteFailure(err);
    await transition(store, id, dispatching, (cur2) => {
      cur2.status = c.kind === "refused" ? "refused" : c.kind === "not_dispatched" ? "abandoned_before_send" : "unknown";
      cur2.outcome = { code: c.code, status: c.status, phase: c.phase ?? "relay_refusal", message: String(err?.message ?? "").slice(0, 300) };
      if (c.hints?.length) addHints(cur2, c.hints);
    });
    throw err;
  }
  const hashes = hintHashes(out);
  if (hashes.length === 0) {
    await transition(store, id, dispatching, (cur2) => {
      cur2.status = "unknown";
      cur2.outcome = { code: "relay_malformed_success", phase: "success_body" };
    });
    fail("relay_malformed_success", "the relay answered without a valid transaction hash; the execution is UNKNOWN (never resent)");
  }
  let cur = await transition(store, id, dispatching, (c) => {
    c.status = "pending";
    c.outcome = { code: out.pending ? "relay_pending" : "relay_success" };
    addHints(c, hashes);
  });
  if (out.pending) return { pending: true, txHash: hashes[0], id };
  const res = await proveCandidate(cur, hashes[0], runtime, rpc);
  if (res.kind !== "exact") return { pending: true, txHash: hashes[0], id, observation: res.kind };
  cur = await transition(store, id, cur, (c) => applyExact(c, res));
  if (out.settlement && BigInt(out.settlement.actual?.totalDebit6 ?? -1) !== BigInt(res.actual.totalDebit6)) {
    fail("relay_settlement_mismatch", "the relay's settlement differs from the canonical receipt (the chain proof is journaled)");
  }
  return {
    pending: false,
    txHash: res.txHash,
    id,
    final: res.final,
    status: cur.status,
    settlement: { actual: { usdcSpent6: BigInt(res.actual.usdcSpent6), fee6: BigInt(res.actual.fee6), totalDebit6: BigInt(res.actual.totalDebit6) } }
  };
}
async function releasePrior(prior, { runtime, store, rpc, relayBase, call }) {
  if (prior.schema !== EXEC_SCHEMA || !RELEASABLE.includes(prior.status)) {
    fail("execute_exists", `${prior.id} already exists (${prior.status}); never overwritten`);
  }
  await verifyStoredIntent(prior, { runtime, store, relayBase });
  const preds = prior.predecessors ?? [];
  if (preds.length >= MAX_PREDECESSORS) {
    fail("predecessor_history_full", `${prior.id} already holds ${preds.length} earlier attempts; this nonce cannot be re-admitted again`);
  }
  if ([prior.call.digest, ...preds.map((p) => p.call.digest)].includes(lower(call.digest))) {
    fail("digest_reused", "this exact signed call was already attempted for this nonce; a new quote is required");
  }
  if (prior.status === "expired_unused") await recheckStoredExpiry(prior, rpc);
  const proof = await proveExpiredUnused(prior, runtime, rpc);
  return { prior, proof };
}
function predecessorOf(prior, proof) {
  const { predecessors: _p, predecessorsHash: _h, ...rest } = prior;
  return { ...rest, release: proof };
}
async function txBinding(entry, h, rc, rpc) {
  const tx = await rpc("eth_getTransactionByHash", [h]);
  if (!tx || typeof tx !== "object") return { kind: "rejected", reason: "tx_unavailable" };
  if (lower(tx.hash) !== h) return { kind: "rejected", reason: "tx_identity" };
  if (rc && (lower(tx.blockHash) !== lower(rc.blockHash) || BigInt(tx.blockNumber ?? -1) !== BigInt(rc.blockNumber))) {
    return { kind: "rejected", reason: "tx_block_mismatch" };
  }
  if (!sameAddr(tx.to ?? "", entry.runtime.vault)) return { kind: "other", direct: false };
  let d;
  try {
    d = decodeFunctionData({ abi: EXECUTE_ABI, data: lower(tx.input ?? tx.data ?? "0x") });
  } catch {
    return { kind: "other", direct: true };
  }
  const [sid, nonce, action, args, fee, deadline, x, y] = d.args;
  if (lower(sid) !== entry.sid || BigInt(nonce) !== BigInt(entry.nonce)) return { kind: "other", direct: true };
  const exact2 = Number(action) === ACTION_GAS_FUND && lower(args) === entry.call.args && BigInt(fee) === BigInt(entry.call.fee) && BigInt(deadline) === BigInt(entry.call.deadline) && BigInt(x) === BigInt(entry.record.x) && BigInt(y) === BigInt(entry.record.y);
  return exact2 ? { kind: "exact" } : { kind: "same_nonce_other_call" };
}
var sessionOpsFor = (rc, entry) => eventsOf(rc, entry.runtime.vault, [SESSION_OP_EVENT]).filter((x) => x.name === "SessionOp" && lower(x.args.sid) === entry.sid && BigInt(x.args.nonce) === BigInt(entry.nonce));
async function proveCandidate(entry, txHash, runtime, rpc) {
  const h = lower(txHash);
  if (!isHash(h)) return { kind: "rejected", txHash: h, reason: "hash_malformed" };
  let rc;
  try {
    rc = await canonicalReceipt(rpc, h);
  } catch (e) {
    if (e?.code === "tx_reverted") {
      const b2 = await txBinding(entry, h, null, rpc);
      return b2.kind === "exact" ? { kind: "reverted_exact", txHash: h } : { kind: "not_ours", txHash: h, reason: "reverted_other" };
    }
    return { kind: "rejected", txHash: h, reason: e?.code ?? "receipt_error" };
  }
  if (!rc) return { kind: "not_canonical", txHash: h };
  const b = await txBinding(entry, h, rc, rpc);
  if (b.kind === "rejected") return { ...b, txHash: h };
  let ops;
  try {
    ops = sessionOpsFor(rc, entry);
  } catch (e) {
    return { kind: "rejected", txHash: h, reason: e?.code ?? "log_decode" };
  }
  if (b.kind === "exact") {
    let st;
    const pinned = { ...runtime, relayer: entry.relayer || runtime.relayer };
    try {
      st = await verifySettlement({
        runtime: pinned,
        rpc,
        txHash: h,
        call: { execute: { sessionId: entry.sid, nonce: BigInt(entry.nonce), fee: BigInt(entry.call.fee) }, args: entry.call.args }
      });
    } catch (e) {
      return { kind: "rejected", txHash: h, reason: e?.code ?? "settlement_error" };
    }
    if (!st) return { kind: "not_canonical", txHash: h };
    let fin2;
    try {
      fin2 = await receiptFinality(rpc, rc);
    } catch (e) {
      return { kind: "rejected", txHash: h, reason: e?.code ?? "finality_error" };
    }
    return {
      kind: "exact",
      txHash: h,
      block: BigInt(rc.blockNumber).toString(),
      blockHash: lower(rc.blockHash),
      final: fin2.final === true,
      finalizedNumber: fin2.finalizedNumber === null ? null : String(fin2.finalizedNumber),
      actual: { usdcSpent6: String(st.actual.usdcSpent6), fee6: String(st.actual.fee6), totalDebit6: String(st.actual.totalDebit6) }
    };
  }
  if (ops.length === 0) return { kind: "not_ours", txHash: h };
  if (ops.length !== 1) return { kind: "contradiction", txHash: h, reason: "session_op_repeats" };
  if (lower(ops[0].args.argsHash) === entry.call.argsHash) {
    return { kind: "contradiction", txHash: h, reason: "exact_op_via_unbound_transaction" };
  }
  let fin;
  try {
    fin = await receiptFinality(rpc, rc);
  } catch (e) {
    return { kind: "rejected", txHash: h, reason: e?.code ?? "finality_error" };
  }
  return {
    kind: "superseding",
    txHash: h,
    block: BigInt(rc.blockNumber).toString(),
    blockHash: lower(rc.blockHash),
    final: fin.final === true,
    finalizedNumber: fin.finalizedNumber === null ? null : String(fin.finalizedNumber),
    otherArgsHash: lower(ops[0].args.argsHash)
  };
}
function keepHistory(c, why) {
  c.history = [...c.history ?? [], { status: c.status, evidence: c.evidence ?? null, why }].slice(-20);
}
function applyExact(c, res) {
  if (c.evidence && c.evidence.txHash !== res.txHash) fail("evidence_conflict", "a different transaction was already proven for this call");
  keepHistory(c, "exact_settlement_proven");
  c.status = res.final ? "settled" : "observed";
  c.evidence = {
    kind: "settlement",
    txHash: res.txHash,
    block: res.block,
    blockHash: res.blockHash,
    final: res.final,
    finalizedNumber: res.finalizedNumber,
    actual: res.actual
  };
  addHints(c, [res.txHash]);
}
function applySuperseding(c, res) {
  keepHistory(c, "nonce_consumed_by_other_operation");
  c.status = res.final ? "superseded" : "superseded_observed";
  c.evidence = {
    kind: "superseded",
    txHash: res.txHash,
    block: res.block,
    blockHash: res.blockHash,
    final: res.final,
    finalizedNumber: res.finalizedNumber,
    otherArgsHash: res.otherArgsHash
  };
}
var notProven = (reason, message, extra) => fail("expiry_not_proven", `expired-unused not proven: ${message}`, { reason, ...extra });
function headerOf(b, name) {
  if (!b || typeof b !== "object" || Array.isArray(b)) notProven("header_missing", `no ${name} header`);
  const n = typeof b.number === "string" ? b.number.toLowerCase() : "";
  const h = typeof b.hash === "string" ? b.hash.toLowerCase() : "";
  const t = typeof b.timestamp === "string" ? b.timestamp.toLowerCase() : "";
  if (!QTY2.test(n) || !H322.test(h) || !QTY2.test(t)) notProven("header_malformed", `the ${name} header number/hash/timestamp is malformed`);
  if (BigInt(n) === 0n || !isHash(h) || BigInt(t) === 0n) notProven("header_zero", `the ${name} header identity is zero`);
  return { number: BigInt(n), hash: h, timestamp: BigInt(t) };
}
async function finalizedHeader(rpc) {
  const fin = headerOf(await rpc("eth_getBlockByNumber", ["finalized", false]), "finalized");
  const at = headerOf(await rpc("eth_getBlockByNumber", [toQty3(fin.number), false]), "numbered");
  if (at.number !== fin.number) notProven("header_number_mismatch", "the header at the finalized number has another number");
  if (at.hash !== fin.hash || at.timestamp !== fin.timestamp) notProven("header_hash_mismatch", "the finalized head and the header at its number differ");
  return fin;
}
function expiryTerms(entry, runtime) {
  const dec = (v, name) => {
    if (typeof v !== "string" || !DEC.test(v)) notProven("metadata_malformed", `${name} is not a canonical decimal`);
    return BigInt(v);
  };
  const c = entry?.call;
  if (!c || !entry.runtime || !entry.record || !entry.anchor) notProven("metadata_missing", "the stored call is incomplete");
  if (entry.runtime.chainId !== "8453" || entry.record.chainId !== "8453" || c.domain?.chainId !== "8453" || Number(runtime?.cfg?.chainId) !== 8453) notProven("wrong_chain", "the stored call or the runtime is not for Base 8453");
  if (!isHash(entry.sid)) notProven("metadata_malformed", "sid");
  const nonce = dec(entry.nonce, "nonce");
  const lane = dec(c.lane, "call.lane");
  const seq = dec(c.seq, "call.seq");
  if (dec(c.nonce, "call.nonce") !== nonce || lane !== nonce >> 64n || seq !== (nonce & MASK64)) {
    notProven("lane_inconsistent", "the stored lane/sequence is not the decomposition (nonce >> 64, nonce & 2^64-1) of the nonce");
  }
  if (seq === MASK64) notProven("metadata_malformed", "the sequence is the lane's last value");
  const deadline = dec(c.deadline, "call.deadline");
  const intentDeadline = dec(c.intent?.deadline, "call.intent.deadline");
  if (deadline === 0n || intentDeadline === 0n) notProven("metadata_zero", "a deadline is zero");
  const anchorNumber = dec(entry.anchor.number, "anchor.number");
  const vault = lower(runtime.cfg.vault);
  const impl = lower(runtime.cfg.implementation);
  if (entry.runtime.vault !== vault || entry.record.vault !== vault || c.domain.verifyingContract !== vault || entry.runtime.implementation !== impl || lower(predictVault(runtime.cfg.factory, runtime.cfg.implementation, runtime.cfg.owner)) !== vault) {
    notProven("vault_mismatch", "the vault is not the verified factory clone of the verified implementation");
  }
  const implCodehash = lower(runtime.pins?.codehashes?.implementation ?? "");
  if (!isHash(implCodehash)) notProven("runtime_pins_missing", "the verified runtime carries no implementation code hash pin");
  return { nonce, lane, seq, deadline, intentDeadline, anchorNumber, vault, impl, implCodehash };
}
async function proveExpiredUnused(entry, runtime, rpc) {
  const t = expiryTerms(entry, runtime);
  const chainId = await rpc("eth_chainId", []);
  if (typeof chainId !== "string" || !QTY2.test(chainId.toLowerCase()) || BigInt(chainId) !== 8453n) notProven("wrong_chain", "the RPC is not Base 8453");
  const fin = await finalizedHeader(rpc);
  if (!(fin.timestamp > t.deadline && fin.timestamp > t.intentDeadline)) {
    notProven("not_past_deadline", `the finalized header (${fin.timestamp}) is not strictly after both deadlines`, { finalizedTimestamp: String(fin.timestamp) });
  }
  if (fin.number <= t.anchorNumber) notProven("not_after_anchor", "the finalized header is not after the pre-send anchor");
  const tag = toQty3(fin.number);
  const vcode = await rpc("eth_getCode", [t.vault, tag]);
  if (typeof vcode !== "string" || vcode.toLowerCase() !== cloneRuntime(t.impl)) {
    notProven("vault_code_mismatch", "the vault's code at the pinned block is not the clone of the verified implementation");
  }
  const icode = await rpc("eth_getCode", [t.impl, tag]);
  if (typeof icode !== "string" || !/^0x([0-9a-f]{2})+$/.test(icode.toLowerCase()) || lower(keccak256(icode.toLowerCase())) !== t.implCodehash) {
    notProven("implementation_code_mismatch", "the implementation's code at the pinned block differs from its verified pin");
  }
  const out = await rpc("eth_call", [{ to: t.vault, data: encodeFunctionData({ abi: SEQ_ABI, functionName: "seqOf", args: [entry.sid, t.lane] }) }, tag]);
  if (typeof out !== "string" || !H322.test(out.toLowerCase()) || BigInt(out) > MASK64) notProven("seq_malformed", "seqOf returned no uint64 word");
  const onchain = BigInt(out);
  if (onchain > t.seq) notProven("nonce_consumed", `seqOf(sid, ${t.lane}) is ${onchain} > ${t.seq}: the nonce was consumed`, { seqOf: String(onchain) });
  if (onchain !== t.seq) notProven("seq_mismatch", `seqOf(sid, ${t.lane}) is ${onchain}, not the stored ${t.seq}`, { seqOf: String(onchain) });
  const again = headerOf(await rpc("eth_getBlockByNumber", [tag, false]), "pinned recheck");
  if (again.number !== fin.number || again.hash !== fin.hash) notProven("reorged", "the pinned header was replaced while it was read");
  const fin2 = headerOf(await rpc("eth_getBlockByNumber", ["finalized", false]), "finalized recheck");
  if (fin2.number < fin.number || fin2.number === fin.number && fin2.hash !== fin.hash) notProven("reorged", "the finalized head moved off the pinned header");
  return {
    kind: "expired_unused",
    chainId: "8453",
    block: fin.number.toString(),
    blockHash: fin.hash,
    timestamp: fin.timestamp.toString(),
    lane: t.lane.toString(),
    seq: t.seq.toString(),
    seqOf: onchain.toString(),
    callDeadline: t.deadline.toString(),
    intentDeadline: t.intentDeadline.toString(),
    digest: entry.call.digest,
    intentHash: entry.intentHash,
    vault: t.vault,
    vaultCodehash: lower(keccak256(cloneRuntime(t.impl))),
    implementationCodehash: t.implCodehash
  };
}
async function recheckStoredExpiry(entry, rpc) {
  const ev = entry.evidence;
  if (ev?.kind !== "expired_unused" || typeof ev.block !== "string" || !DEC.test(ev.block) || !isHash(ev.blockHash) || ev.intentHash !== entry.intentHash || ev.digest !== entry.call.digest || ev.seq !== entry.call.seq || ev.lane !== entry.call.lane) {
    notProven("evidence_malformed", "the stored expired-unused evidence is incomplete or not for this call");
  }
  const n = BigInt(ev.block);
  const fin = headerOf(await rpc("eth_getBlockByNumber", ["finalized", false]), "finalized");
  const at = headerOf(await rpc("eth_getBlockByNumber", [toQty3(n), false]), "evidence");
  if (at.number !== n) notProven("header_number_mismatch", "the header at the evidence number has another number");
  if (at.hash !== ev.blockHash || fin.number < n || fin.number === n && fin.hash !== ev.blockHash) {
    notProven("evidence_reorged", "the stored expiry header is no longer the finalized canonical header at its number");
  }
  return { finalizedNumber: fin.number.toString(), evidenceBlock: ev.block };
}
async function verifyStoredIntent(entry, { runtime, store, relayBase }) {
  const bad = (why) => fail("intent_invalid", `stored execution ${entry?.id} cannot be trusted: ${why}`, { why });
  if (!entry || entry.kind !== "gas-execute" || entry.schema !== EXEC_SCHEMA) bad("not an r2 execution entry");
  for (const k of INTENT_KEYS) if (entry[k] === void 0 || entry[k] === null) bad(`missing ${k}`);
  if (hashOf(intentPart(entry)) !== entry.intentHash) bad("intentHash mismatch (edited entry)");
  if (entry.id !== execId(entry.sid, entry.nonce)) bad("id does not match sid/nonce");
  if (!sameJson(runtimeIdentity(runtime), entry.runtime)) bad("the verified runtime differs from the one the call was built for");
  if (normRelay(relayBase) !== entry.relay) bad("another relay");
  const rec = await store.loadKey(entry.record.id);
  if (!rec) bad("its gas record is missing");
  const ri = recordIdentity(rec);
  if (!sameJson({ ...ri, sid: entry.record.sid }, entry.record) || lower(rec.sid) !== entry.sid) bad("its gas record differs");
  let rebuilt;
  try {
    const i = entry.call.intent;
    rebuilt = buildGasFundCall(runtime.cfg, {
      domainVersion: "2",
      now: BigInt(entry.call.builtAt),
      sessionId: entry.sid,
      nonce: BigInt(entry.call.nonce),
      action: ACTION_GAS_FUND,
      intent: {
        payer: i.payer,
        deployment: i.deployment,
        expectedOwner: i.expectedOwner,
        ethOut: BigInt(i.ethOut),
        maxUsdcIn6: BigInt(i.maxUsdcIn6),
        fee: Number(i.fee),
        deadline: BigInt(i.deadline)
      },
      fee: BigInt(entry.call.fee),
      deadline: BigInt(entry.call.deadline)
    });
  } catch (e) {
    bad(`the codec refuses the stored call (${e?.code ?? e?.message})`);
  }
  const d = rebuilt.typedData.domain;
  if (lower(rebuilt.digest) !== entry.call.digest || lower(rebuilt.args) !== entry.call.args || lower(rebuilt.argsHash) !== entry.call.argsHash || d.name !== entry.call.domain.name || String(d.version) !== entry.call.domain.version || String(d.chainId) !== entry.call.domain.chainId || lower(d.verifyingContract) !== entry.call.domain.verifyingContract || entry.call.nonce !== entry.nonce || rebuilt.maximum.totalMaximum6.toString() !== entry.maximum.totalMaximum6) bad("the stored call does not re-derive to its digest/args/domain/maximum");
  if (!/^\d+$/.test(entry.anchor.number) || !isHash(entry.anchor.hash)) bad("malformed anchor");
  if (entry.predecessors !== void 0 || entry.predecessorsHash !== void 0) verifyPredecessors(entry, bad);
  return rebuilt;
}
function verifyPredecessors(entry, bad) {
  const ps = entry.predecessors;
  if (!Array.isArray(ps) || ps.length === 0 || ps.length > MAX_PREDECESSORS) bad("malformed predecessor history");
  if (entry.predecessorsHash !== hashOf(ps)) bad("predecessor history edited");
  const seen = /* @__PURE__ */ new Set([entry.call.digest]);
  for (const p of ps) {
    if (!p || p.kind !== "gas-execute" || p.schema !== EXEC_SCHEMA || p.id !== entry.id || p.sid !== entry.sid || p.nonce !== entry.nonce) bad("predecessor identity");
    for (const k of INTENT_KEYS) if (p[k] === void 0 || p[k] === null) bad(`predecessor missing ${k}`);
    if (hashOf(intentPart(p)) !== p.intentHash) bad("predecessor intentHash mismatch");
    if (!RELEASABLE.includes(p.status) || p.release?.kind !== "expired_unused" || p.release.intentHash !== p.intentHash || p.release.digest !== p.call.digest) bad("predecessor without its expired-unused release");
    if (seen.has(p.call.digest)) bad("a signed digest repeats in the predecessor history");
    seen.add(p.call.digest);
  }
}
async function relayHints(relay, entry) {
  if (typeof relay !== "function") return [];
  try {
    const v = await relay("GET", `/funding/session/${entry.runtime.vault}/${entry.sid}`);
    return (Array.isArray(v?.ops) ? v.ops : []).filter((o) => String(o?.nonce) === entry.nonce).map((o) => o.tx).filter(isHash).map(lower);
  } catch {
    return [];
  }
}
async function discover(rpc, entry, limits) {
  const span = BigInt(limits?.maxBlocks ?? MAX_DISCOVERY_BLOCKS);
  if (span <= 0n || span > MAX_DISCOVERY_BLOCKS) fail("discovery_bounds", `maxBlocks must be 1..${MAX_DISCOVERY_BLOCKS}`);
  const latest = await rpc("eth_getBlockByNumber", ["latest", false]);
  const from = BigInt(entry.anchor.number);
  const head = BigInt(latest?.number ?? -1);
  if (head < from) return { hashes: [], window: { from: entry.anchor.number, to: null, complete: false }, rejected: [] };
  const to = from + span < head ? from + span : head;
  const endBlk = await rpc("eth_getBlockByNumber", [toQty3(to), false]);
  const logs = await rpc("eth_getLogs", [{ address: entry.runtime.vault, topics: [SESSION_OP_TOPIC, entry.sid], fromBlock: toQty3(from), toBlock: toQty3(to) }]);
  const hashes = [], rejected = [];
  for (const l of Array.isArray(logs) ? logs : []) {
    if (l?.removed !== false) {
      rejected.push({ txHash: lower(l?.transactionHash), reason: "log_removed" });
      continue;
    }
    const n = BigInt(l.blockNumber ?? -1);
    if (n < from || n > to) {
      rejected.push({ txHash: lower(l.transactionHash), reason: "log_outside_window" });
      continue;
    }
    if (isHash(l.transactionHash)) hashes.push(lower(l.transactionHash));
  }
  const pastDeadline = endBlk?.timestamp !== void 0 && BigInt(endBlk.timestamp) > BigInt(entry.call.deadline);
  return { hashes, rejected, window: { from: entry.anchor.number, to: to.toString(), complete: pastDeadline } };
}
async function reconcileGasExecution({ runtime, store, rpc, relay, relayBase, id, limits }) {
  const entry = await store.getJournal(id);
  if (!entry) fail("execution_missing", `no execution ${id}`);
  if (entry.schema !== EXEC_SCHEMA) return { verdict: "legacy_unverifiable", status: entry.status, id };
  try {
    await verifyStoredIntent(entry, { runtime, store, relayBase });
  } catch (e) {
    if (e?.code === "intent_invalid") return { verdict: "intent_invalid", status: entry.status, id, why: e.detail?.why };
    throw e;
  }
  if (entry.status === "expired_unused") {
    try {
      const recheck = await recheckStoredExpiry(entry, rpc);
      return { verdict: "resolved", status: entry.status, id, evidence: entry.evidence, recheck };
    } catch (e) {
      if (e?.code !== "expiry_not_proven" || e.detail?.reason !== "evidence_reorged") {
        return { verdict: "expiry_recheck_failed", status: entry.status, id, why: e?.detail?.reason ?? String(e?.code ?? e?.name ?? "error") };
      }
      const back = await transition(store, id, entry, (x) => {
        keepHistory(x, "expiry_evidence_reorged");
        x.status = "unknown";
        x.evidence = null;
      });
      return reconcileGasExecution({ runtime, store, rpc, relay, relayBase, id: back.id, limits });
    }
  }
  if (CLEARED.includes(entry.status)) return { verdict: "resolved", status: entry.status, id };
  if (entry.status === "admitted") {
    const c2 = await transition(store, id, entry, (x) => {
      keepHistory(x, "no_dispatch_marker");
      x.status = "never_dispatched";
    });
    return { verdict: "resolved", status: c2.status, id };
  }
  if ((entry.status === "observed" || entry.status === "superseded_observed") && entry.evidence?.txHash) {
    const res = await proveCandidate(entry, entry.evidence.txHash, runtime, rpc);
    const wanted = entry.status === "observed" ? "exact" : "superseding";
    if (res.kind === wanted && res.blockHash === entry.evidence.blockHash) {
      if (!res.final) return { verdict: "observed_not_final", status: entry.status, id, evidence: entry.evidence };
      const c2 = await transition(store, id, entry, (x) => wanted === "exact" ? applyExact(x, res) : applySuperseding(x, res));
      return { verdict: "resolved", status: c2.status, id, evidence: c2.evidence };
    }
    const back = await transition(store, id, entry, (x) => {
      keepHistory(x, `evidence_${res.kind}${res.reason ? `:${res.reason}` : ""}`);
      x.status = "unknown";
      x.evidence = null;
    });
    return reconcileGasExecution({ runtime, store, rpc, relay, relayBase, id: back.id, limits });
  }
  const fromRelay = await relayHints(relay, entry);
  const found = await discover(rpc, entry, limits);
  const candidates = [.../* @__PURE__ */ new Set([...entry.hints?.txHashes ?? [], ...fromRelay, ...found.hashes])];
  const observation = { window: found.window, candidates: candidates.length, rejected: [...found.rejected] };
  if (candidates.length > MAX_CANDIDATES) {
    return { verdict: "unresolved", status: entry.status, id, why: "too_many_candidates", observation };
  }
  const results = [];
  for (const h of candidates) results.push(await proveCandidate(entry, h, runtime, rpc));
  for (const r of results) if (!["exact", "superseding"].includes(r.kind)) observation.rejected.push({ txHash: r.txHash, kind: r.kind, reason: r.reason ?? null });
  const exact2 = [...new Map(results.filter((r) => r.kind === "exact").map((r) => [r.txHash, r])).values()];
  const sup = [...new Map(results.filter((r) => r.kind === "superseding").map((r) => [r.txHash, r])).values()];
  const contra = results.filter((r) => r.kind === "contradiction");
  if (contra.length || exact2.length > 1 || sup.length > 1 || exact2.length && sup.length) {
    return { verdict: "contradiction", status: entry.status, id, observation };
  }
  const record = (x) => {
    x.lastReconcile = observation;
  };
  if (exact2.length === 1) {
    const c2 = await transition(store, id, entry, (x) => {
      applyExact(x, exact2[0]);
      record(x);
    });
    return { verdict: c2.status === "settled" ? "resolved" : "observed_not_final", status: c2.status, id, evidence: c2.evidence };
  }
  if (sup.length === 1) {
    const c2 = await transition(store, id, entry, (x) => {
      applySuperseding(x, sup[0]);
      record(x);
    });
    return { verdict: c2.status === "superseded" ? "resolved" : "observed_not_final", status: c2.status, id, evidence: c2.evidence };
  }
  let proof = null;
  if (EXPIRABLE.includes(entry.status)) {
    try {
      proof = await proveExpiredUnused(entry, runtime, rpc);
      observation.expiry = { proven: true };
    } catch (e) {
      observation.expiry = { proven: false, reason: e?.code === "expiry_not_proven" ? String(e.detail?.reason) : `error:${String(e?.code ?? e?.name ?? "unknown")}` };
    }
  }
  if (proof) {
    const c2 = await transition(store, id, entry, (x) => {
      keepHistory(x, "expired_unused_proven");
      x.status = "expired_unused";
      x.evidence = proof;
      record(x);
    });
    return { verdict: "resolved", status: c2.status, id, evidence: c2.evidence, observation };
  }
  const revertedExact = results.some((r) => r.kind === "reverted_exact");
  const c = await transition(store, id, entry, (x) => {
    if (revertedExact && x.status !== "reverted_observed") {
      keepHistory(x, "exact_call_reverted_on_chain");
      x.status = "reverted_observed";
    }
    record(x);
  });
  return {
    verdict: "unresolved",
    status: c.status,
    id,
    observation,
    why: revertedExact ? "reverted_signature_may_still_be_usable" : found.window.complete ? "no_canonical_operation_found_in_bounded_window" : "window_not_past_deadline"
  };
}
var CLEARED_TEXT = Object.freeze({
  settled: "Funded: the exact payment is final on chain.",
  superseded: "Not funded by this payment: its nonce was used by another operation (final on chain).",
  refused: "Not sent: the relay refused it before sending. Nothing was charged.",
  never_dispatched: "Not sent: it was never dispatched. Nothing was charged.",
  abandoned_before_send: "Not sent: cancelled before sending. Nothing was charged.",
  expired_unused: "Expired unused, never funded: a finalized Base block after its deadline shows its nonce unused, so it can never execute and charged nothing. A new quote and a new signature are needed to pay."
});
function executionStatusView(status) {
  const cleared = CLEARED.includes(status);
  return Object.freeze({ status: String(status), cleared, funded: status === "settled", text: cleared ? CLEARED_TEXT[status] : null });
}
function listGasExecutions(entries, record) {
  return (entries || []).filter((e) => e?.kind === "gas-execute" && lower(e.sid) === lower(record.sid) && (e.schema !== EXEC_SCHEMA || e.record?.id === String(record.id))).map((e) => ({
    id: e.id,
    status: e.status,
    blocking: isBlocking(e),
    schema: e.schema ?? "r4",
    nonce: e.schema === EXEC_SCHEMA ? e.nonce : String(e.nonce ?? ""),
    deployment: e.deployment ?? null,
    maximum: e.maximum ?? null,
    evidence: e.evidence ?? null,
    hints: e.hints?.txHashes ?? e.txHashes ?? [],
    predecessors: Array.isArray(e.predecessors) ? e.predecessors.length : 0,
    funded: e.schema === EXEC_SCHEMA ? e.status === "settled" : false
  }));
}
async function quoteGasFund2(input) {
  const entries = input.journalEntries ?? [];
  const blockers = executionBlockers(entries, input.record);
  if (blockers.length) {
    fail("unreconciled_execute", "an earlier gas.fund of this session is not resolved; check its status first (never resent)", { ids: blockers.map((x) => x.id) });
  }
  return quoteGasFund({ ...input, journalEntries: entries.filter((e) => !(e?.kind === "gas-execute" && e.schema === EXEC_SCHEMA && CLEARED.includes(e.status))) });
}
export {
  CHAIN_ID,
  CLEARED,
  DEFINITIVE_REFUSALS,
  EXEC_SCHEMA,
  EXPIRABLE,
  GAS_GRANT_CANDIDATE,
  IndexedDbV2Store,
  JOURNAL,
  KEYS,
  LEGACY_DB,
  MAX_CANDIDATES,
  MAX_COMBINED6,
  MAX_DISCOVERY_BLOCKS,
  MAX_GRANT_APPS2 as MAX_GRANT_APPS,
  MAX_OBSERVATION_AGE,
  MAX_PREDECESSORS,
  MIGRATION_SCHEMA,
  MemoryV2Store,
  MigrationError,
  ORDER,
  OWNER_OP_WINDOW,
  READ_ABI,
  RECEIVE_TYPES,
  RECORD_KIND,
  RECORD_VERSION,
  RELEASABLE,
  REPLACED_FIELDS,
  RUNTIME_SCHEMA,
  RelayError,
  SIGN_WINDOW,
  STEP_NOTES,
  V1_GRANT_FIELDS,
  V2_DB,
  V2_DB_VERSION,
  actionsMaskV1,
  adoptReplacement,
  appScopeOf,
  assertPublic,
  bindReview,
  buildGasGrant,
  buildMigrationPlan,
  canon,
  canonicalReceipt,
  classifyExecuteFailure,
  compareGrantToChain,
  confirmGasFund,
  controlsTarget,
  depositTypedData,
  endGasSession,
  envMask,
  ethCall,
  execId,
  executionBlockers,
  executionStatusView,
  fail,
  finalityPolicy,
  freshRecoveryScope,
  gasRecordId,
  gasStepsOf,
  grantBody,
  hashOf,
  isBlocking,
  isGasStep,
  jsonRpc,
  jsonable,
  legacyChain,
  listGasExecutions,
  loadLegacyEvidence,
  lower,
  newGasKey,
  newGasRecord,
  normState,
  normalizeWire,
  nowSec,
  orderOf,
  ownerControl,
  parseRuntimePins,
  parseSplit,
  partOf,
  pinBlock,
  prepareGasOpen,
  proveCandidate,
  proveExpiredUnused,
  proveGasOpen,
  proveStep,
  quoteGasFund2 as quoteGasFund,
  randomHex32,
  rearmStep,
  rebuildGasReview,
  receiptFinality,
  reconcileFundingTx,
  reconcileGasExecution,
  reconcileMigration,
  relayClient,
  replacementFromJournal,
  requireApproval,
  runMigration,
  sameAddr,
  selectGasRecord,
  signGasOpen,
  signSteps,
  signerFor,
  submitGasOpen,
  usdcDomain,
  v1GrantFromJson,
  validateGasRecord,
  verifyRuntime,
  verifySettlement,
  verifyStoredIntent,
  walletSignTyped,
  wireFetch
};
/*! Bundled license information:

@noble/hashes/esm/utils.js:
  (*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) *)

@noble/curves/esm/abstract/utils.js:
@noble/curves/esm/abstract/modular.js:
@noble/curves/esm/abstract/curve.js:
@noble/curves/esm/abstract/weierstrass.js:
@noble/curves/esm/_shortw_utils.js:
@noble/curves/esm/secp256k1.js:
  (*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) *)
*/
