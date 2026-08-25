#!/usr/bin/env node
/**
 * Quick MCP tool caller — talks JSON-RPC over stdio to an MCP server.
 * Usage:  node mcp_call.js <tool_name> '<json_args>'
 *         node mcp_call.js --loop
 * Example: node mcp_call.js emu_control '{"command":"launch","machine":"National_CF-3300"}'
 * Loop mode: reads lines as:
 *   <tool> <command> {json_args}
 *   <tool> <command> key value [key value ...]    (quote values containing spaces)
 *   <tool> <command> positional args              (mapped to schema parameters by order)
 * Commands: help [tool], debug on|off, exit
 * Interactive TTYs get TAB completion of tool names and commands.
 */
import { spawn } from 'child_process';
import * as readline from 'readline';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const argv = process.argv.slice(2);
const loopMode = argv.includes('--loop');

let openmsxShareDirArg = null;
const shareDirIdx = argv.indexOf('--openmsx-share-dir');
if (shareDirIdx !== -1) {
  openmsxShareDirArg = argv[shareDirIdx + 1] || null;
  argv.splice(shareDirIdx, 2);
}

const loopIdx = argv.indexOf('--loop');
if (loopIdx !== -1) argv.splice(loopIdx, 1);

const [toolName, argsJson] = argv;

if (!loopMode && !toolName) {
  console.error('Usage: node mcp_call.js <tool_name> \'{"arg":"value"}\'');
  console.error('       node mcp_call.js --loop   (reads commands from stdin)');
  console.error('       node mcp_call.js --openmsx-share-dir <path>   (optional; auto-detected otherwise)');
  console.error('Loop format: <tool> <command> [{json} | key value ... | positional args]');
  console.error('  Quoted values are kept as a single parameter: condition "[reg A] == 0x42"');
  console.error('Commands: help [tool], debug on|off, exit');
  console.error('Example: emu_control launch National_CF-3300');
  console.error('Example: debug_breakpoints create address 0x4010 condition "[reg A] == 0x42"');
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const srvCommand = 'node';
const srvArgs = [join(__dirname, 'mcp-server', 'dist', 'server.js')];

const child = spawn(srvCommand, srvArgs, {
  stdio: ['pipe', 'pipe', 'pipe'],
  // Only override OPENMSX_SHARE_DIR when explicitly requested; otherwise let
  // the server inherit the environment or auto-detect (incl. /opt/openMSX/share).
  env: openmsxShareDirArg ? { ...process.env, OPENMSX_SHARE_DIR: openmsxShareDirArg } : { ...process.env },
});

let buffer = '';
let callId = 1;
const pending = new Map(); // json-rpc id -> resolve

child.stdout.on('data', (chunk) => {
  if (process.env.MCP_CALL_DEBUG) console.error('[raw<<]', JSON.stringify(chunk.toString()));
  buffer += chunk.toString();
  // Try to parse complete JSON objects from buffer
  const lines = buffer.split('\n');
  buffer = lines.pop(); // keep incomplete last line
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj.id !== undefined && pending.has(obj.id)) {
        pending.get(obj.id)(obj);
        pending.delete(obj.id);
      }
    } catch {}
  }
});

child.stderr.on('data', (chunk) => {
  // Forward server diagnostics; silent server failures are undebuggable.
  process.stderr.write(`[server] ${chunk}`);
});

function send(obj) {
  const msg = JSON.stringify(obj) + '\n';
  if (process.env.MCP_CALL_DEBUG) console.error('[raw>>]', msg.length > 200 ? msg.slice(0, 200) + '…' : msg);
  child.stdin.write(msg);
}

function rpcCall(method, params) {
  return new Promise((resolve) => {
    const id = callId++;
    pending.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, params });
  });
}

function callTool(name, args) {
  return rpcCall('tools/call', { name, arguments: args });
}

const toolSchemas = new Map();
let debugMode = false;

async function listTools() {
  const res = await rpcCall('tools/list', {});
  const tools = res.result?.tools || [];
  for (const tool of tools) {
    toolSchemas.set(tool.name, tool.inputSchema);
  }
}

// Shell-like tokenizer: bare tokens split on whitespace; double- or single-quoted
// sections (with \" and \\ escapes) become a single token.
function tokenize(str) {
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
  const tokens = [];
  let m;
  while ((m = re.exec(str)) !== null) {
    if (m[1] !== undefined) tokens.push(m[1].replace(/\\(.)/g, '$1'));
    else if (m[2] !== undefined) tokens.push(m[2]);
    else tokens.push(m[3]);
  }
  return tokens;
}

function coerceValue(key, value, prop) {
  const type = Array.isArray(prop.type) ? prop.type[0] : prop.type;
  switch (type) {
    case 'boolean': {
      const v = value.toLowerCase();
      if (v === 'true') return true;
      if (v === 'false') return false;
      throw new Error(`expected boolean for '${key}' (true|false), got "${value}"`);
    }
    case 'number':
    case 'integer': {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(`expected number for '${key}', got "${value}"`);
      if (type === 'integer' && !Number.isInteger(n)) throw new Error(`expected integer for '${key}', got "${value}"`);
      return n;
    }
    case 'array': {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) return parsed;
      } catch {}
      return value.split(',').map(s => s.trim()).filter(s => s.length > 0);
    }
    default:
      return value;
  }
}

// Parse loop-mode arguments after the command: '{json}' object, 'key value ...'
// pairs, or a positional list. KV mode triggers when the first token (or any
// even-indexed token) is a schema property name; it is then validated strictly.
// Rare ambiguity (a positional call whose values are all key names): use {json}.
function parseLoopArgs(toolName, after) {
  if (after.startsWith('{')) return JSON.parse(after);
  const schema = toolSchemas.get(toolName);
  const props = (schema && schema.properties) || {};
  const tokens = tokenize(after);
  const kvIntent = tokens.length > 0 &&
    tokens.some((t, i) => i % 2 === 0 && Object.hasOwn(props, t));
  if (!kvIntent) return tokens;
  if (tokens.length % 2 !== 0) {
    throw new Error(`missing value for '${tokens[tokens.length - 1]}'`);
  }
  const obj = {};
  for (let i = 0; i < tokens.length; i += 2) {
    if (!Object.hasOwn(props, tokens[i])) {
      throw new Error(`unknown parameter '${tokens[i]}'. Valid: ${Object.keys(props).join(', ')}`);
    }
    obj[tokens[i]] = coerceValue(tokens[i], tokens[i + 1], props[tokens[i]]);
  }
  return obj;
}

function wrapText(text, width) {
  const lines = [];
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = '';
    for (const w of words) {
      if (line && (line + ' ' + w).length > width) { lines.push(line); line = w; }
      else line = line ? line + ' ' + w : w;
    }
    if (line) lines.push(line);
  }
  return lines;
}

function showHelp(toolName) {
  if (!toolName) {
    console.log('Available tools:');
    for (const name of toolSchemas.keys()) console.log(`  ${name}`);
    console.log('Use "help <tool>" to see its parameters.');
    return;
  }
  const schema = toolSchemas.get(toolName);
  if (!schema) {
    console.error(`Error: unknown tool "${toolName}". Use "help" to list tools.`);
    return;
  }
  const required = schema.required || [];
  console.log(`${toolName}`);
  for (const [key, prop] of Object.entries(schema.properties || {})) {
    const type = Array.isArray(prop.type) ? prop.type.join('|') : (prop.type || 'any');
    const bits = [`  ${key} <${type}>`, required.includes(key) ? '(required)' : '(optional)'];
    if (prop.enum) bits.push(`[${prop.enum.join('|')}]`);
    if (prop.default !== undefined) bits.push(`(default: ${JSON.stringify(prop.default)})`);
    console.log(bits.join(' '));
    if (prop.description) {
      for (const line of wrapText(prop.description, 72)) console.log(`        ${line}`);
    }
  }
}

function buildArgs(toolName, command, extraJson) {
  const schema = toolSchemas.get(toolName);
  if (!schema) return extraJson || {};
  const args = {};
  const props = schema.properties || {};
  // Set command if the schema has a command property
  if (props.command) args.command = command;
  // Fill in defaults from schema
  for (const [key, prop] of Object.entries(props)) {
    if (key === 'command') continue;
    if (prop.default !== undefined) args[key] = prop.default;
  }
  if (extraJson) {
    if (Array.isArray(extraJson)) {
      // Positional args: map to schema properties by order (skip 'command')
      const positional = Object.keys(props).filter(k => k !== 'command');
      for (let i = 0; i < extraJson.length && i < positional.length; i++) {
        args[positional[i]] = extraJson[i];
      }
    } else {
      // Named args: merge directly
      Object.assign(args, extraJson);
    }
  }
  return args;
}

async function initServer() {
  send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mcp_call', version: '1.0.0' }
  }});
  await new Promise(r => setTimeout(r, 1000));
  send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  await new Promise(r => setTimeout(r, 500));
}

// Tab completion for loop mode (interactive TTYs only): first token completes
// tool names and special commands; second token completes the tool's command
// enum, help's tool argument, or debug on|off.
// NOTE: readline REPLACES the returned match substring with each hit, so the
// second element must be the last word, not the whole line.
function tabCompleter(line) {
  const trailingSpace = /\s$/.test(line);
  const parts = line.split(/\s+/);
  let matchOn;
  let candidates = [];
  if (!trailingSpace && parts.length <= 1) {
    matchOn = parts[0] || '';
    candidates = [...new Set(['debug', 'exit', 'help', 'quit', ...toolSchemas.keys()])].sort();
  } else if (!trailingSpace && parts.length === 2) {
    matchOn = parts[1];
    const head = parts[0];
    if (head === 'help') candidates = [...toolSchemas.keys()].sort();
    else if (head === 'debug') candidates = ['off', 'on'];
    else {
      const prop = toolSchemas.get(head)?.properties?.command;
      if (prop?.enum) candidates = [...prop.enum].sort();
    }
  } else {
    return [[], line];
  }
  return [candidates.filter(c => c.startsWith(matchOn)), matchOn];
}

async function singleCall() {
  const args = argsJson ? JSON.parse(argsJson) : {};
  const result = await callTool(toolName, args);
  console.log(JSON.stringify(result, null, 2));
  child.kill();
  process.exit(0);
}

async function loopCalls(rl, queued, isInputClosed) {
  // Wake mechanism so the drain loop can wait for new lines or EOF.
  const wake = { notify: () => {} };
  rl.on('line', () => wake.notify());
  rl.on('close', () => wake.notify());
  const waitForInput = () => new Promise((resolve) => {
    wake.notify = resolve;
    // Re-check after registering: a line/EOF may have arrived meanwhile
    if (queued.length > 0 || isInputClosed()) resolve();
  });

  let chain = Promise.resolve();
  while (true) {
    while (queued.length === 0 && !isInputClosed()) await waitForInput();
    if (queued.length === 0 && isInputClosed()) break;
    const line = queued.shift();
    const trimmed = line.trim();
    if (trimmed === 'exit' || trimmed === 'quit') break;
    chain = chain.then(() => handleLine(rl, line));
    await chain.catch(() => {});
  }
  rl.close();
  child.kill();
  process.exit(0);
}

async function handleLine(rl, line) {
  const trimmed = line.trim();
  if (!trimmed) { rl.prompt(); return; }
  try {
    const spaceIdx = trimmed.indexOf(' ');
    const head = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
    const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

    if (head === 'debug') {
      if (rest && !/^(on|off)$/i.test(rest)) {
        console.error('Usage: debug [on|off]');
      } else {
        debugMode = rest ? rest.toLowerCase() === 'on' : !debugMode;
        console.log(`debug ${debugMode ? 'enabled' : 'disabled'}.`);
      }
      rl.prompt();
      return;
    }

    if (head === 'help') {
      showHelp(rest ? rest.split(/\s+/)[0] : null);
      rl.prompt();
      return;
    }

    if (spaceIdx === -1) {
      console.error('Format: <tool> <command> [{json} | key value ... | positional args]');
      rl.prompt();
      return;
    }
    const tool = head;
    const spaceIdx2 = rest.indexOf(' ');
    let command, extraArgs;
    if (spaceIdx2 === -1) {
      command = rest;
      extraArgs = null;
    } else {
      command = rest.slice(0, spaceIdx2);
      extraArgs = parseLoopArgs(tool, rest.slice(spaceIdx2 + 1).trim());
    }
    const args = buildArgs(tool, command, extraArgs);
    if (debugMode) console.error('[debug] arguments:', JSON.stringify(args, null, 2));
    const result = await callTool(tool, args);
    console.log(JSON.stringify(result));
  } catch (e) {
    console.error(`Error: ${e.message}`);
  }
  rl.prompt();
}

async function main() {
  // Attach to stdin IMMEDIATELY: piped input may close before the init
  // handshake finishes, so lines must be buffered, not read late.
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY === true,
    prompt: 'mcp> ',
    completer: tabCompleter,
  });
  const queued = [];
  let inputClosed = false;
  rl.on('line', (line) => queued.push(line));
  rl.on('close', () => { inputClosed = true; });

  await initServer();
  if (!loopMode) {
    rl.close();
    await singleCall();
    return;
  }
  await listTools();
  console.error(`Loaded ${toolSchemas.size} tool schemas.`);
  console.error('Use "help <tool>" to see its parameters.');
  rl.prompt();
  await loopCalls(rl, queued, () => inputClosed);
}

main().catch(e => { console.error(e.message); child.kill(); process.exit(1); });
if (!loopMode) setTimeout(() => { child.kill(); process.exit(1); }, 10000);
process.on('SIGINT', () => { child.kill(); process.exit(0); });
