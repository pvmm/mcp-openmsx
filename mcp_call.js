#!/usr/bin/env node
/**
 * Quick MCP tool caller — talks JSON-RPC over stdio to an MCP server.
 * Usage:  node mcp_call.js <tool_name> '<json_args>'
 *         node mcp_call.js --loop
 * Example: node mcp_call.js emu_control '{"command":"launch","machine":"National_CF-3300"}'
 * Loop mode: reads lines as <tool> <command> {json_args}
 */
import { spawn } from 'child_process';
import * as readline from 'readline';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const argv = process.argv.slice(2);
const loopMode = argv.includes('--loop');

let openmsxShareDir = '/usr/share/openmsx';
const shareDirIdx = argv.indexOf('--openmsx-share-dir');
if (shareDirIdx !== -1) {
  openmsxShareDir = argv[shareDirIdx + 1] || openmsxShareDir;
  argv.splice(shareDirIdx, 2);
}

const loopIdx = argv.indexOf('--loop');
if (loopIdx !== -1) argv.splice(loopIdx, 1);

const [toolName, argsJson] = argv;

if (!loopMode && !toolName) {
  console.error('Usage: node mcp_call.js <tool_name> \'{"arg":"value"}\'');
  console.error('       node mcp_call.js --loop   (reads commands from stdin)');
  console.error('       node mcp_call.js --openmsx-share-dir <path>');
  console.error('Loop format: <tool> <command> {json_args}');
  console.error('Example: echo \'emu_control launch {"machine":"National_CF-3300"}\' | node mcp_call.js --loop');
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const srvCommand = 'node';
const srvArgs = [join(__dirname, 'mcp-server', 'dist', 'server.js')];

const child = spawn(srvCommand, srvArgs, {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, OPENMSX_SHARE_DIR: openmsxShareDir },
});

let buffer = '';
let responsePromise;
let callId = 1;

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  // Try to parse complete JSON objects from buffer
  const lines = buffer.split('\n');
  buffer = lines.pop(); // keep incomplete last line
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (responsePromise && obj.id !== undefined) {
        responsePromise(obj);
        responsePromise = null;
      }
    } catch {}
  }
});

child.stderr.on('data', (chunk) => {
  // suppress server stderr
});

function send(obj) {
  const msg = JSON.stringify(obj) + '\n';
  child.stdin.write(msg);
}

function callTool(name, args) {
  return new Promise((resolve) => {
    responsePromise = resolve;
    send({ jsonrpc: '2.0', id: callId++, method: 'tools/call', params: { name, arguments: args } });
  });
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

async function singleCall() {
  const args = argsJson ? JSON.parse(argsJson) : {};
  const result = await callTool(toolName, args);
  console.log(JSON.stringify(result, null, 2));
  child.kill();
  process.exit(0);
}

async function loopCalls() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    prompt: 'mcp> ',
  });
  rl.prompt();
  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) { rl.prompt(); return; }
    try {
      const spaceIdx = trimmed.indexOf(' ');
      if (spaceIdx === -1) { console.error('Format: <tool> <command> {json_args}'); rl.prompt(); return; }
      const tool = trimmed.slice(0, spaceIdx);
      const rest = trimmed.slice(spaceIdx + 1);
      const spaceIdx2 = rest.indexOf(' ');
      let command, args;
      if (spaceIdx2 === -1) {
        command = rest;
        args = {};
      } else {
        command = rest.slice(0, spaceIdx2);
        args = JSON.parse(rest.slice(spaceIdx2 + 1));
      }
      const result = await callTool(tool, { command, ...args });
      console.log(JSON.stringify(result));
    } catch (e) {
      console.error(`Error: ${e.message}`);
    }
    rl.prompt();
  });
  rl.on('close', () => { child.kill(); process.exit(0); });
}

async function main() {
  await initServer();
  if (loopMode) {
    loopCalls();
  } else {
    singleCall();
  }
}

main().catch(e => { console.error(e.message); child.kill(); process.exit(1); });
if (!loopMode) setTimeout(() => { child.kill(); process.exit(1); }, 10000);
process.on('SIGINT', () => { child.kill(); process.exit(0); });
