// Copyright 2021 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import * as SDK from '../../../core/sdk/sdk.js';
import * as Formatter from '../../../models/formatter/formatter.js';
import * as JavaScriptMetaData from '../../../models/javascript_metadata/javascript_metadata.js';
import * as CodeMirror from '../../../third_party/codemirror.next/codemirror.next.js';
import * as UI from '../../legacy/legacy.js';
import {cursorTooltip} from './cursor_tooltip.js';

export async function completion(): Promise<CodeMirror.Extension> {
  const {javascriptLanguage} = await CodeMirror.javascript();
  return javascriptLanguage.data.of({
    autocomplete: javascriptCompletionSource,
  });
}

class CompletionSet {
  constructor(
      readonly completions: CodeMirror.Completion[] = [],
      readonly seen: Set<string> = new Set(),
  ) {
  }

  add(completion: CodeMirror.Completion): void {
    if (!this.seen.has(completion.label)) {
      this.seen.add(completion.label);
      this.completions.push(completion);
    }
  }

  copy(): CompletionSet {
    return new CompletionSet(this.completions.slice(), new Set(this.seen));
  }
}

const javascriptKeywords = [
  'async',  'await',      'break',  'case',   'catch',   'class',   'const',  'continue', 'debugger', 'default',
  'delete', 'do',         'else',   'export', 'extends', 'finally', 'for',    'function', 'if',       'import',
  'in',     'instanceof', 'let',    'new',    'of',      'return',  'static', 'super',    'switch',   'this',
  'throw',  'try',        'typeof', 'var',    'void',    'while',   'with',   'yield',
];
const consoleBuiltinFunctions = [
  'clear',
  'copy',
  'debug',
  'dir',
  'dirxml',
  'getEventListeners',
  'inspect',
  'keys',
  'monitor',
  'monitorEvents',
  'profile',
  'profileEnd',
  'queryObjects',
  'table',
  'undebug',
  'unmonitor',
  'unmonitorEvents',
  'values',
];
const consoleBuiltinVariables = ['$', '$$', '$x', '$0', '$_'];

const baseCompletions = new CompletionSet();
for (const kw of javascriptKeywords) {
  baseCompletions.add({label: kw, type: 'keyword'});
}
for (const builtin of consoleBuiltinFunctions) {
  baseCompletions.add({label: builtin, type: 'function'});
}
for (const varName of consoleBuiltinVariables) {
  baseCompletions.add({label: varName, type: 'variable'});
}

const dontCompleteIn = new Set([
  'TemplateString',
  'LineComment',
  'BlockComment',
  'TypeDefinition',
  'VariableDefinition',
  'PropertyDefinition',
  'TypeName',
]);

// FIXME Implement Map property completion?
export const enum QueryType {
  Expression = 0,
  PropertyName = 1,
  PropertyExpression = 2,
}

export function getQueryType(tree: CodeMirror.Tree, pos: number): {
  type: QueryType,
  from?: number,
  relatedNode?: CodeMirror.SyntaxNode,
}|null {
  let node = tree.resolveInner(pos, -1);
  const parent = node.parent;
  if (dontCompleteIn.has(node.name)) {
    return null;
  }

  if (node.name === 'VariableName') {
    return {type: QueryType.Expression, from: node.from};
  }
  if (node.name === 'PropertyName') {
    return parent?.name !== 'MemberExpression' ? null :
                                                 {type: QueryType.PropertyName, from: node.from, relatedNode: parent};
  }
  if (node.name === 'String') {
    const parent = node.parent;
    return parent?.name === 'MemberExpression' && parent.childBefore(node.from)?.name === '[' ?
        {type: QueryType.PropertyExpression, from: node.from, relatedNode: parent} :
        null;
  }
  // Enter unfinished nodes before the position.
  node = node.enterUnfinishedNodesBefore(pos);
  // Normalize to parent node when pointing after a child of a member expr.
  if (node.to === pos && node.parent?.name === 'MemberExpression') {
    node = node.parent;
  }
  if (node.name === 'MemberExpression') {
    const before = node.childBefore(Math.min(pos, node.to));
    if (before?.name === '[') {
      return {type: QueryType.PropertyExpression, relatedNode: node};
    }
    if (before?.name === '.' || before?.name === '?.') {
      return {type: QueryType.PropertyName, relatedNode: node};
    }
  }
  return {type: QueryType.Expression};
}

export async function javascriptCompletionSource(cx: CodeMirror.CompletionContext):
    Promise<CodeMirror.CompletionResult|null> {
  const query = getQueryType(CodeMirror.syntaxTree(cx.state), cx.pos);
  if (!query || query.from === undefined && !cx.explicit) {
    return null;
  }

  let result: CompletionSet;
  if (query.type === QueryType.Expression) {
    const [scope, global] = await Promise.all([
      completeExpressionInScope(),
      completeExpressionGlobal(),
    ]);
    if (scope.completions.length) {
      result = scope;
      for (const r of global.completions) {
        result.add(r);
      }
    } else {
      result = global;
    }
  } else if (query.type === QueryType.PropertyName || query.type === QueryType.PropertyExpression) {
    const objectExpr = (query.relatedNode as CodeMirror.SyntaxNode).getChild('Expression');
    let quote = undefined;
    if (query.type === QueryType.PropertyExpression) {
      quote = query.from === undefined ? '\'' : cx.state.sliceDoc(query.from, query.from + 1);
    }
    if (!objectExpr) {
      return null;
    }
    result = await completeProperties(cx.state.sliceDoc(objectExpr.from, objectExpr.to), quote);
  } else {
    return null;
  }
  return {
    from: query.from ?? cx.pos,
    options: result.completions,
    span: /^[\w\P{ASCII}]*/u,
  };
}

function getExecutionContext(): SDK.RuntimeModel.ExecutionContext|null {
  return UI.Context.Context.instance().flavor(SDK.RuntimeModel.ExecutionContext);
}

async function evaluateExpression(
    context: SDK.RuntimeModel.ExecutionContext,
    expression: string,
    group: string,
    ): Promise<SDK.RemoteObject.RemoteObject|null> {
  const result = await context.evaluate(
      {
        expression,
        objectGroup: group,
        includeCommandLineAPI: true,
        silent: true,
        returnByValue: false,
        generatePreview: false,
        throwOnSideEffect: true,
        timeout: 500,
      },
      false, false);
  if ('error' in result || result.exceptionDetails || !result.object) {
    return null;
  }
  return result.object;
}

const primitivePrototypes = new Map<string, string>([
  ['string', 'String'],
  ['number', 'Number'],
  ['boolean', 'Boolean'],
  ['bigint', 'BigInt'],
]);

const maxCacheAge = 30_000;

let cacheInstance: PropertyCache|null = null;

// Store recent collections of property completions. The empty string
// is used to store the set of global bindings.
class PropertyCache {
  private readonly cache: Map<string, Promise<CompletionSet>> = new Map();

  constructor() {
    const clear = (): void => this.cache.clear();
    SDK.ConsoleModel.ConsoleModel.instance().addEventListener(SDK.ConsoleModel.Events.CommandEvaluated, clear);
    UI.Context.Context.instance().addFlavorChangeListener(SDK.RuntimeModel.ExecutionContext, clear);
    SDK.TargetManager.TargetManager.instance().addModelListener(
        SDK.DebuggerModel.DebuggerModel, SDK.DebuggerModel.Events.DebuggerResumed, clear);
    SDK.TargetManager.TargetManager.instance().addModelListener(
        SDK.DebuggerModel.DebuggerModel, SDK.DebuggerModel.Events.DebuggerPaused, clear);
  }

  get(expression: string): Promise<CompletionSet>|undefined {
    return this.cache.get(expression);
  }

  set(expression: string, value: Promise<CompletionSet>): void {
    this.cache.set(expression, value);
    setTimeout(() => {
      if (this.cache.get(expression) === value) {
        this.cache.delete(expression);
      }
    }, maxCacheAge);
  }

  static instance(): PropertyCache {
    if (!cacheInstance) {
      cacheInstance = new PropertyCache();
    }
    return cacheInstance;
  }
}

async function completeProperties(
    expression: string,
    quoted?: string,
    ): Promise<CompletionSet> {
  const cache = PropertyCache.instance();
  if (!quoted) {
    const cached = cache.get(expression);
    if (cached) {
      return cached;
    }
  }
  const context = getExecutionContext();
  if (!context) {
    return new CompletionSet();
  }
  const result = completePropertiesInner(expression, context, quoted);
  if (!quoted) {
    cache.set(expression, result);
  }
  return result;
}

const prototypePropertyPenalty = -80;

async function completePropertiesInner(
    expression: string,
    context: SDK.RuntimeModel.ExecutionContext,
    quoted?: string,
    ): Promise<CompletionSet> {
  const result = new CompletionSet();
  if (!context) {
    return result;
  }
  let object = await evaluateExpression(context, expression, 'completion');
  if (!object) {
    return result;
  }

  while (object.type === 'object' && object.subtype === 'proxy') {
    const properties = await object.getOwnProperties(false);
    const innerObject = properties.internalProperties?.find(p => p.name === '[[Target]]')?.value;
    if (!innerObject) {
      break;
    }
    object = innerObject as SDK.RemoteObject.RemoteObject;
  }

  const toPrototype = object.subtype === 'array' ?
      'Array' :
      object.subtype === 'typedarray' ? 'Uint8Array' : primitivePrototypes.get(object.type);
  if (toPrototype) {
    object = await evaluateExpression(context, toPrototype + '.prototype', 'completion');
  }

  const functionType = expression === 'window' ? 'function' : 'method';
  const otherType = expression === 'window' ? 'variable' : 'property';
  if (object && (object.type === 'object' || object.type === 'function')) {
    const properties = await object.getAllProperties(false, false);
    const isFunction = object.type === 'function';
    for (const prop of properties.properties || []) {
      if (!prop.symbol && !(isFunction && (prop.name === 'arguments' || prop.name === 'caller'))) {
        const label = quoted ? quoted + prop.name + quoted : prop.name;
        const completion: CodeMirror.Completion = {
          label,
          type: prop.value?.type === 'function' ? functionType : otherType,
        };
        if (quoted) {
          completion.apply = label + ']';
        }
        if (!prop.isOwn) {
          completion.boost = prototypePropertyPenalty;
        }
        result.add(completion);
      }
    }
  }
  context.runtimeModel.releaseObjectGroup('completion');
  return result;
}

async function completeExpressionInScope(): Promise<CompletionSet> {
  const result = new CompletionSet();
  const selectedFrame = getExecutionContext()?.debuggerModel.selectedCallFrame();
  if (!selectedFrame) {
    return result;
  }

  const frames =
      await Promise.all(selectedFrame.scopeChain().map(scope => scope.object().getAllProperties(false, false)));
  for (const frame of frames) {
    for (const property of frame.properties || []) {
      result.add({
        label: property.name,
        type: property.value?.type === 'function' ? 'function' : 'variable',
      });
    }
  }
  return result;
}

async function completeExpressionGlobal(): Promise<CompletionSet> {
  const cache = PropertyCache.instance();
  const cached = cache.get('');
  if (cached) {
    return cached;
  }

  const context = getExecutionContext();
  if (!context) {
    return baseCompletions;
  }
  const result = baseCompletions.copy();

  const fetchNames = completePropertiesInner('window', context).then(fromWindow => {
    return context.globalLexicalScopeNames().then(globals => {
      for (const option of fromWindow.completions) {
        result.add(option);
      }
      for (const name of globals || []) {
        result.add({label: name, type: 'variable'});
      }
      return result;
    });
  });
  cache.set('', fetchNames);
  return fetchNames;
}

export function isExpressionComplete(state: CodeMirror.EditorState): boolean {
  for (const cursor = CodeMirror.syntaxTree(state).cursor(); cursor.next();) {
    if (cursor.type.isError) {
      return false;
    }
  }
  return true;
}

export function argumentHints(): CodeMirror.Extension {
  return cursorTooltip(getArgumentHints);
}

async function getArgumentHints(
    state: CodeMirror.EditorState, pos: number): Promise<(() => CodeMirror.TooltipView)|null> {
  const node = CodeMirror.syntaxTree(state).resolveInner(pos).enterUnfinishedNodesBefore(pos);

  if (node.name !== 'ArgList') {
    return null;
  }
  const callee = node.parent?.getChild('Expression');
  if (!callee) {
    return null;
  }
  const argumentList = await getArgumentsForExpression(callee, state.doc);
  if (!argumentList) {
    return null;
  }

  let argumentIndex = 0;
  for (let scanPos = pos;;) {
    const before = node.childBefore(scanPos);
    if (!before) {
      break;
    }
    if (before.type.is('Expression')) {
      argumentIndex++;
    }
    scanPos = before.from;
  }
  return (): {dom: HTMLElement} => tooltipBuilder(argumentList, argumentIndex);
}

async function getArgumentsForExpression(
    callee: CodeMirror.SyntaxNode, doc: CodeMirror.Text): Promise<string[][]|null> {
  const context = getExecutionContext();
  if (!context) {
    return null;
  }
  try {
    const expression = doc.sliceString(callee.from, callee.to);
    const result = await evaluateExpression(context, expression, 'argumentsHint');
    if (!result || result.type !== 'function') {
      return null;
    }
    return getArgumentsForFunctionValue(result, async () => {
      const first = callee.firstChild;
      if (!first || callee.name !== 'MemberExpression') {
        return null;
      }
      return evaluateExpression(context, doc.sliceString(first.from, first.to), 'argumentsHint');
    }, expression);
  } finally {
    context.runtimeModel.releaseObjectGroup('argumentsHint');
  }
}

async function getArgumentsForFunctionValue(
    object: SDK.RemoteObject.RemoteObject,
    receiverObjGetter: () => Promise<SDK.RemoteObject.RemoteObject|null>,
    functionName?: string,
    ): Promise<string[][]|null> {
  const description = object.description;
  if (!description) {
    return null;
  }
  if (!description.endsWith('{ [native code] }')) {
    return [await Formatter.FormatterWorkerPool.formatterWorkerPool().argumentsList(description)];
  }

  // Check if this is a bound function.
  if (description === 'function () { [native code] }') {
    const fromBound = await getArgumentsForBoundFunction(object);
    if (fromBound) {
      return fromBound;
    }
  }

  const javaScriptMetadata = JavaScriptMetaData.JavaScriptMetadata.JavaScriptMetadataImpl.instance();

  const descriptionRegexResult = /^function ([^(]*)\(/.exec(description);
  const name = descriptionRegexResult && descriptionRegexResult[1] || functionName;
  if (!name) {
    return null;
  }
  const uniqueSignatures = javaScriptMetadata.signaturesForNativeFunction(name);
  if (uniqueSignatures) {
    return uniqueSignatures;
  }
  const receiverObj = await receiverObjGetter();
  if (!receiverObj) {
    return null;
  }
  const className = receiverObj.className;
  if (className) {
    const instanceMethods = javaScriptMetadata.signaturesForInstanceMethod(name, className);
    if (instanceMethods) {
      return instanceMethods;
    }
  }

  // Check for static methods on a constructor.
  if (receiverObj.description && receiverObj.type === 'function' &&
      receiverObj.description.endsWith('{ [native code] }')) {
    const receiverDescriptionRegexResult = /^function ([^(]*)\(/.exec(receiverObj.description);
    if (receiverDescriptionRegexResult) {
      const receiverName = receiverDescriptionRegexResult[1];
      const staticSignatures = javaScriptMetadata.signaturesForStaticMethod(name, receiverName);
      if (staticSignatures) {
        return staticSignatures;
      }
    }
  }

  for (const proto of await prototypesFromObject(receiverObj)) {
    const instanceSignatures = javaScriptMetadata.signaturesForInstanceMethod(name, proto);
    if (instanceSignatures) {
      return instanceSignatures;
    }
  }
  return null;
}

async function prototypesFromObject(object: SDK.RemoteObject.RemoteObject): Promise<string[]> {
  if (object.type === 'number') {
    return ['Number', 'Object'];
  }
  if (object.type === 'string') {
    return ['String', 'Object'];
  }
  if (object.type === 'symbol') {
    return ['Symbol', 'Object'];
  }
  if (object.type === 'bigint') {
    return ['BigInt', 'Object'];
  }
  if (object.type === 'boolean') {
    return ['Boolean', 'Object'];
  }
  if (object.type === 'undefined' || object.subtype === 'null') {
    return [];
  }
  return await object.callFunctionJSON(function() {
    const result = [];
    for (let object: Object = this; object; object = Object.getPrototypeOf(object)) {
      if (typeof object === 'object' && object.constructor && object.constructor.name) {
        result[result.length] = object.constructor.name;
      }
    }
    return result;
  }, []);
}

// Given a function object that is probably a bound function, try to
// retrieve the argument list from its target function.
async function getArgumentsForBoundFunction(object: SDK.RemoteObject.RemoteObject): Promise<string[][]|null> {
  const {internalProperties} = await object.getOwnProperties(false);
  if (!internalProperties) {
    return null;
  }
  const target = internalProperties.find(p => p.name === '[[TargetFunction]]')?.value;
  const args = internalProperties.find(p => p.name === '[[BoundArgs]]')?.value;
  const thisValue = internalProperties.find(p => p.name === '[[BoundThis]]')?.value;
  if (!thisValue || !target || !args) {
    return null;
  }
  const originalSignatures = await getArgumentsForFunctionValue(target, () => Promise.resolve(thisValue));
  const boundArgsLength = SDK.RemoteObject.RemoteObject.arrayLength(args);
  if (!originalSignatures) {
    return null;
  }
  return originalSignatures.map(signature => {
    const restIndex = signature.findIndex(arg => arg.startsWith('...'));
    return restIndex > -1 && restIndex < boundArgsLength ? signature.slice(restIndex) :
                                                           signature.slice(boundArgsLength);
  });
}

function tooltipBuilder(signatures: string[][], currentIndex: number): {dom: HTMLElement} {
  const tooltip = document.createElement('div');
  tooltip.className = 'cm-argumentHints';
  for (const args of signatures) {
    const argumentsElement = document.createElement('span');
    for (let i = 0; i < args.length; i++) {
      if (i === currentIndex || (i < currentIndex && args[i].startsWith('...'))) {
        const argElement = argumentsElement.appendChild(document.createElement('b'));
        argElement.appendChild(document.createTextNode(args[i]));
      } else {
        argumentsElement.appendChild(document.createTextNode(args[i]));
      }
      if (i < args.length - 1) {
        argumentsElement.appendChild(document.createTextNode(', '));
      }
    }
    const signatureElement = tooltip.appendChild(document.createElement('div'));
    signatureElement.className = 'source-code';
    signatureElement.appendChild(document.createTextNode('\u0192('));
    signatureElement.appendChild(argumentsElement);
    signatureElement.appendChild(document.createTextNode(')'));
  }
  return {dom: tooltip};
}
