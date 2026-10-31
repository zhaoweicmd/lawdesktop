/**
 * DSH 工具 schema 编译（作者 DSL → 宿主认的 raw JSON Schema）
 *
 * 为什么需要这一层（已在宿主日志里实测到）：
 *   宿主 ToolRuntime.register() 只接受**已编译的 raw JSON Schema**；
 *   而 `parameters` 也必须是 raw JSON Schema（{type:'object', properties, required?}）。
 *   这一步本应由宿主 defineTool() 完成，但插件里
 *   `await import('@deepseek-ai/dsh-tools')` 加载不到时会静默退化成恒等函数，
 *   作者 DSL（属性级 `required: true`）就原样进了 register，被逐条拒成：
 *     unsupported JSON schema: schema.properties.text.required is not supported on type "string"
 *   （2026-10-21 05:17:22Z 本插件首装即踩中，3 个工具全部注册失败。）
 *
 * 现在不依赖宿主模块，按宿主同一套规则自己编译，注册路径完全自持。
 *
 * 宿主允许的 schema 键：type / properties / required / additionalProperties / items / enum / const
 * 注解键：description / title / default / examples
 */

const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples']
const SCALARS = ['string', 'number', 'integer', 'boolean', 'null']

function fail(path, msg) {
  throw new Error(`schema ${path} ${msg}`)
}

function copyAnnotations(src, dst) {
  for (const k of ANNOTATION_KEYS) if (Object.hasOwn(src, k)) dst[k] = src[k]
}

function assertKeys(input, path, allowed) {
  for (const k of Object.keys(input)) {
    if (!allowed.includes(k)) fail(`${path}.${k}`, `不是合法 schema 键（允许：${allowed.join('/')}）`)
  }
}

/** 编译单个节点。allowRequired=true 时允许属性级 required: true */
function compileNode(input, path, allowRequired) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail(path, '必须是对象')
  const allowed = ANNOTATION_KEYS.concat(allowRequired ? ['required'] : [])
  const type = input.type

  if (type === undefined) {
    assertKeys(input, path, ANNOTATION_KEYS)
    const node = {}
    copyAnnotations(input, node)
    return { node, required: input.required === true }
  }

  if (type === 'object') {
    assertKeys(input, path, allowed.concat(['type', 'properties', 'additionalProperties']))
    const node = { type: 'object' }
    copyAnnotations(input, node)
    node.additionalProperties =
      typeof input.additionalProperties === 'boolean' ? input.additionalProperties : false
    if (input.properties !== undefined) {
      if (input.properties === null || typeof input.properties !== 'object' || Array.isArray(input.properties)) {
        fail(`${path}.properties`, '必须是对象')
      }
      const out = {}
      const req = []
      for (const [k, v] of Object.entries(input.properties)) {
        const r = compileNode(v, `${path}.properties.${k}`, true)
        out[k] = r.node
        if (r.required) req.push(k)
      }
      node.properties = out
      if (req.length) node.required = req
    }
    return { node, required: input.required === true }
  }

  if (type === 'array') {
    assertKeys(input, path, allowed.concat(['type', 'items']))
    const node = { type: 'array' }
    copyAnnotations(input, node)
    if (Object.hasOwn(input, 'items')) {
      node.items = compileNode(input.items, `${path}.items`, false).node
    }
    return { node, required: input.required === true }
  }

  if (SCALARS.includes(type)) {
    assertKeys(input, path, allowed.concat(['type', 'enum', 'const']))
    const node = { type }
    copyAnnotations(input, node)
    if (Array.isArray(input.enum)) node.enum = input.enum.slice()
    if (Object.hasOwn(input, 'const')) node.const = input.const
    return { node, required: input.required === true }
  }

  fail(`${path}.type`, `不支持的类型 "${String(type)}"（允许：${['object', 'array'].concat(SCALARS).join('/')}）`)
}

/** parameters：扁平作者 DSL → 根对象 raw schema */
export function compileParams(spec) {
  const src = spec === undefined || spec === null ? {} : spec
  if (typeof src !== 'object' || Array.isArray(src)) throw new Error('parameters 必须是对象')
  const properties = {}
  const required = []
  for (const [k, v] of Object.entries(src)) {
    const r = compileNode(v, `parameters.${k}`, true)
    properties[k] = r.node
    if (r.required) required.push(k)
  }
  const out = { type: 'object', additionalProperties: false, properties }
  if (required.length) out.required = required
  return out
}

/** output.schema：根节点不允许属性级 required */
export function compileOutput(spec) {
  return compileNode(spec, 'schema', false).node
}

/**
 * 把作者 DSL 的工具定义编译成 register() 直接可用的定义。
 * 注意：不经过宿主 defineTool，避免 import 失败时静默退化。
 */
export function defineRawTool(options) {
  const parameters = compileParams(options.parameters)
  const output = options.output || {}
  const render = output.render
  if (typeof render !== 'function') throw new Error(`tool "${options.name}" 必须带 output.render`)

  const tool = {
    name: options.name,
    description: options.description,
    parameters,
    output: { schema: compileOutput(output.schema), render },
    async execute(args, exec) {
      return options.execute(args === undefined || args === null ? {} : args, exec)
    },
  }
  if (options.timeoutMs !== undefined) tool.timeoutMs = options.timeoutMs
  if (options.deferLoading === true) tool.deferLoading = true
  return tool
}

/**
 * 宿主 raw schema 子集离线校验，供自检用：返回违规列表，空数组 = 宿主会接受。
 */
export function assertRawSchema(schema, path = 'schema') {
  const bads = []
  const walk = (node, at) => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
      bads.push(`${at} 必须是对象`)
      return
    }
    const type = node.type
    const allowed = ANNOTATION_KEYS.concat(['type', 'oneOf'])
    if (type === 'object') allowed.push('properties', 'required', 'additionalProperties')
    if (type === 'array') allowed.push('items')
    if (SCALARS.includes(type)) allowed.push('enum', 'const')

    const restricted = { properties: ['object'], required: ['object'], additionalProperties: ['object'], items: ['array'] }
    for (const k of Object.keys(node)) {
      if (!allowed.includes(k)) bads.push(`${at}.${k} is not supported on type "${String(type)}"`)
      else if (restricted[k] && !restricted[k].includes(type)) {
        bads.push(`${at}.${k} is not supported on type "${String(type)}"`)
      }
    }
    if (type === 'object') {
      if (node.additionalProperties !== undefined && typeof node.additionalProperties !== 'boolean') {
        bads.push(`${at}.additionalProperties must be a boolean`)
      }
      if (node.required !== undefined) {
        if (!Array.isArray(node.required) || node.required.some((x) => typeof x !== 'string')) {
          bads.push(`${at}.required must be an array of strings`)
        } else if (node.properties) {
          for (const k of node.required) {
            if (!Object.hasOwn(node.properties, k)) bads.push(`${at}.required names unknown property ${k}`)
          }
        }
      }
      if (node.properties !== undefined) {
        if (node.properties === null || typeof node.properties !== 'object' || Array.isArray(node.properties)) {
          bads.push(`${at}.properties must be an object`)
        } else {
          for (const [k, v] of Object.entries(node.properties)) walk(v, `${at}.properties.${k}`)
        }
      }
    }
    if (type === 'array' && node.items !== undefined) walk(node.items, `${at}.items`)
    if (Array.isArray(node.oneOf)) node.oneOf.forEach((b, i) => walk(b, `${at}.oneOf[${i}]`))
  }
  walk(schema, path)
  return bads
}
