import ts from 'typescript';
/** Remote declarations and their namespace must belong to the same concrete Controller class. */
export function remoteDeclarations(source) {
  const ast = ts.createSourceFile('owner.ts', source, ts.ScriptTarget.Latest, true);
  const methods = new Map();
  let remoteBinding;
  for (const node of ast.statements)
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === '@axterm/plugin-api'
    )
      for (const item of node.importClause?.namedBindings?.elements ?? [])
        if ((item.propertyName?.text ?? item.name.text) === 'Remote')
          remoteBinding = item.name.text;
  if (!remoteBinding) return methods;
  for (const node of ast.statements) {
    if (!ts.isClassDeclaration(node)) continue;
    const namespaces = new Set();
    const scan = (part) => {
      if (ts.isCallExpression(part) && part.expression.kind === ts.SyntaxKind.SuperKeyword)
        for (const argument of part.arguments)
          if (ts.isObjectLiteralExpression(argument))
            for (const property of argument.properties)
              if (
                ts.isPropertyAssignment(property) &&
                property.name.getText(ast) === 'namespace' &&
                ts.isStringLiteral(property.initializer)
              )
                namespaces.add(property.initializer.text);
      ts.forEachChild(part, scan);
    };
    for (const member of node.members) if (ts.isConstructorDeclaration(member)) scan(member);
    if (namespaces.size !== 1) continue;
    const namespace = [...namespaces][0];
    for (const member of node.members) {
      if (
        !ts.isMethodDeclaration(member) ||
        !member.body ||
        !member.name ||
        ts
          .getModifiers(member)
          ?.some((modifier) =>
            [
              ts.SyntaxKind.PrivateKeyword,
              ts.SyntaxKind.ProtectedKeyword,
              ts.SyntaxKind.StaticKeyword,
            ].includes(modifier.kind),
          )
      )
        continue;
      const remote = ts.getDecorators(member)?.some((decorator) => {
        const expression = ts.isCallExpression(decorator.expression)
          ? decorator.expression.expression
          : decorator.expression;
        return ts.isIdentifier(expression) && expression.text === remoteBinding;
      });
      if (remote) methods.set(namespace + '.' + member.name.getText(ast), true);
    }
  }
  return methods;
}
/** Closed exceptions describe real infrastructure/selected Client boundaries, never fictional business RPCs. */
export const selected = [
  {
    ids: ['authBootstrap', 'authLogout'],
    kind: 'service',
    module: '@axterm/infra-connection',
    source: 'packages/infra/connection/src/rpc-host.ts',
    namespace: 'connection',
    ownerNamespace: 'desktop',
    transport: 'http-auth',
    className: 'HostConnectionService',
    methods: ['authorizeConnect'],
  },
  {
    ids: ['getCapabilities'],
    kind: 'service',
    module: '@axterm/infra-client-modules',
    source: 'packages/infra/client-modules/src/index.ts',
    namespace: 'clientModules',
    ownerNamespace: 'desktop',
    transport: 'bootstrap',
    className: 'ClientModuleRegistry',
    methods: ['graph'],
  },
  {
    ids: ['getDesktopWindowState'],
    kind: 'client-service',
    module: '@axterm/plugin-desktop',
    source: 'packages/plugins/desktop/src/client/shortcuts.ts',
    namespace: 'desktopWindowUi',
    ownerNamespace: 'desktop',
    transport: 'native',
    functionName: 'installDesktopShortcuts',
    methods: ['getState'],
  },
  {
    ids: ['performDesktopWindowAction'],
    kind: 'client-service',
    module: '@axterm/plugin-desktop',
    source: 'packages/plugins/desktop/src/client/shortcuts.ts',
    namespace: 'desktopWindowUi',
    ownerNamespace: 'desktop',
    transport: 'native',
    functionName: 'installDesktopShortcuts',
    methods: ['act'],
  },
  {
    ids: ['importDroppedFileGrant'],
    kind: 'client-service',
    module: '@axterm/plugin-files',
    source: 'packages/plugins/files/src/client/index.ts',
    namespace: 'fileGrantActions',
    ownerNamespace: 'files',
    transport: 'streaming-http',
    functionName: 'apply',
    methods: ['importFile'],
  },
  {
    ids: ['insertGrantedTerminalPaths'],
    kind: 'client-service',
    module: '@axterm/plugin-terminals',
    source: 'packages/plugins/terminals/src/client/ui.tsx',
    namespace: 'terminalInputUi',
    ownerNamespace: 'terminals',
    transport: 'binary-ws',
    functionName: 'installTerminalUi',
    methods: ['sendInput'],
  },
];
const publicNode = (node) =>
  !ts
    .getModifiers(node)
    ?.some((m) =>
      [
        ts.SyntaxKind.PrivateKeyword,
        ts.SyntaxKind.ProtectedKeyword,
        ts.SyntaxKind.StaticKeyword,
      ].includes(m.kind),
    );
const exported = (node) =>
  ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
const visit = (node, callback) => {
  callback(node);
  ts.forEachChild(node, (child) => visit(child, callback));
};
const safePath = (path) =>
  typeof path === 'string' &&
  !path.startsWith('/') &&
  !path.includes('\\') &&
  !path.split('/').some((p) => !p || p === '.' || p === '..');
/** Bind only an exported Cordis Service's real key/public method body. */
export function serviceMethods(source, className, namespace) {
  const ast = ts.createSourceFile('owner.ts', source, ts.ScriptTarget.Latest, true),
    aliases = new Set();
  for (const statement of ast.statements)
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === '@deepseek-ai/cordis'
    )
      for (const name of statement.importClause?.namedBindings?.elements ?? [])
        if ((name.propertyName?.text ?? name.name.text) === 'Service') aliases.add(name.name.text);
  const result = new Set();
  for (const statement of ast.statements) {
    if (
      !ts.isClassDeclaration(statement) ||
      statement.name?.text !== className ||
      !exported(statement) ||
      !statement.heritageClauses?.some(
        (c) =>
          c.token === ts.SyntaxKind.ExtendsKeyword &&
          c.types.some((t) => ts.isIdentifier(t.expression) && aliases.has(t.expression.text)),
      )
    )
      continue;
    let key;
    for (const member of statement.members)
      if (ts.isConstructorDeclaration(member))
        visit(member, (node) => {
          if (
            ts.isCallExpression(node) &&
            node.expression.kind === ts.SyntaxKind.SuperKeyword &&
            node.arguments[1] &&
            ts.isStringLiteral(node.arguments[1])
          )
            key = node.arguments[1].text;
        });
    if (key !== namespace) continue;
    for (const member of statement.members)
      if (ts.isMethodDeclaration(member) && member.body && publicNode(member))
        result.add(member.name.getText(ast));
  }
  return result;
}
/** Follow the owning Context and its inject scopes to a concrete provided object. */
export function clientServiceMethods(source, functionName, namespace, tsx = false) {
  const ast = ts.createSourceFile(
    tsx ? 'owner.tsx' : 'owner.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const result = new Set(),
    contexts = new Set();
  for (const statement of ast.statements)
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === '@deepseek-ai/cordis'
    )
      for (const name of statement.importClause?.namedBindings?.elements ?? [])
        if ((name.propertyName?.text ?? name.name.text) === 'Context') contexts.add(name.name.text);
  const fn = ast.statements.find(
    (s) => ts.isFunctionDeclaration(s) && s.name?.text === functionName && exported(s),
  );
  const parameter = fn?.parameters[0];
  if (
    !fn?.body ||
    !parameter ||
    !ts.isIdentifier(parameter.name) ||
    !parameter.type ||
    !ts.isTypeReferenceNode(parameter.type) ||
    !ts.isIdentifier(parameter.type.typeName) ||
    !contexts.has(parameter.type.typeName.text)
  )
    return result;
  const scopes = new Set([parameter.name.text]),
    objects = new Map();
  visit(fn.body, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer) &&
      node.parent.flags & ts.NodeFlags.Const
    )
      objects.set(node.name.text, node.initializer);
  });
  let count;
  do {
    count = scopes.size;
    visit(fn.body, (node) => {
      if (
        !ts.isCallExpression(node) ||
        !ts.isPropertyAccessExpression(node.expression) ||
        node.expression.name.text !== 'inject' ||
        !ts.isIdentifier(node.expression.expression) ||
        !scopes.has(node.expression.expression.text)
      )
        return;
      const callback = node.arguments.at(-1);
      if (
        callback &&
        (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
        callback.parameters[0] &&
        ts.isIdentifier(callback.parameters[0].name)
      )
        scopes.add(callback.parameters[0].name.text);
    });
  } while (scopes.size !== count);
  visit(fn.body, (node) => {
    if (
      !ts.isCallExpression(node) ||
      !ts.isPropertyAccessExpression(node.expression) ||
      node.expression.name.text !== 'provide' ||
      !ts.isIdentifier(node.expression.expression) ||
      !scopes.has(node.expression.expression.text) ||
      !node.arguments[0] ||
      !ts.isStringLiteral(node.arguments[0]) ||
      node.arguments[0].text !== namespace
    )
      return;
    const value = node.arguments[1],
      object = value && ts.isIdentifier(value) ? objects.get(value.text) : value;
    if (!object || !ts.isObjectLiteralExpression(object)) return;
    for (const member of object.properties) {
      if (ts.isMethodDeclaration(member) && member.body) result.add(member.name.getText(ast));
      if (
        ts.isPropertyAssignment(member) &&
        (ts.isArrowFunction(member.initializer) || ts.isFunctionExpression(member.initializer)) &&
        member.initializer.body
      )
        result.add(member.name.getText(ast));
    }
  });
  return result;
}
/** Only these three credential operations may bind their dedicated authenticated binary carrier. */
const credentialIds = new Set([
  'claimRdpSessionCredentials',
  'claimVncSessionCredentials',
  'claimSpiceSessionCredentials',
]);
function credentialRoute(binding, source) {
  if (
    binding.module !== '@axterm/plugin-remote-desktop' ||
    binding.source !== 'packages/plugins/remote-desktop/src/adapters/binary-stream.ts' ||
    binding.className !== 'RemoteDesktopBinaryStream' ||
    binding.pathSymbol !== 'REMOTE_DESKTOP_CREDENTIAL_PATH'
  )
    return false;
  const ast = ts.createSourceFile('owner.ts', source, ts.ScriptTarget.Latest, true);
  let imported;
  for (const statement of ast.statements)
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === '@axterm/plugin-api/remote-desktop'
    )
      for (const name of statement.importClause?.namedBindings?.elements ?? [])
        if ((name.propertyName?.text ?? name.name.text) === binding.pathSymbol)
          imported = name.name.text;
  if (!imported) return false;
  const declaration = ast.statements.find(
    (s) => ts.isClassDeclaration(s) && s.name?.text === binding.className && exported(s),
  );
  const constructor = declaration?.members.find(ts.isConstructorDeclaration),
    first = constructor?.parameters[0];
  if (!constructor?.body || !first || !ts.isIdentifier(first.name)) return false;
  let registered = false;
  visit(constructor.body, (node) => {
    if (
      !ts.isCallExpression(node) ||
      !ts.isPropertyAccessExpression(node.expression) ||
      node.expression.name.text !== 'registerUpgrade'
    )
      return;
    const receiver = node.expression.expression;
    if (
      !ts.isPropertyAccessExpression(receiver) ||
      receiver.name.text !== 'webServer' ||
      !ts.isIdentifier(receiver.expression) ||
      receiver.expression.text !== first.name.text
    )
      return;
    const options = node.arguments[0];
    if (!options || !ts.isObjectLiteralExpression(options)) return;
    const path = options.properties.find(
        (p) => ts.isPropertyAssignment(p) && p.name.getText(ast) === 'path',
      ),
      handler = options.properties.find(
        (p) => ts.isPropertyAssignment(p) && p.name.getText(ast) === 'handler',
      );
    if (!path || !handler || !ts.isArrowFunction(handler.initializer) || !handler.initializer.body)
      return;
    visit(path.initializer, (node) => {
      if (ts.isIdentifier(node) && node.text === imported) registered = true;
    });
  });
  return registered;
}
export function isSelectedOperationTarget(row) {
  return selected.some(
    (policy) =>
      policy.ids.includes(row.operationId) &&
      row.namespace === policy.ownerNamespace &&
      row.transport === policy.transport &&
      policy.methods.some((method) => row.target === policy.namespace + '.' + method),
  );
}
/** Pure structural validation. It never substitutes for behavior or packaged evidence. */
export function inspectBindings(id, bindings, assets) {
  const errors = [],
    targets = new Set();
  for (const binding of bindings ?? []) {
    const directory = assets.packages.get(binding.module),
      source = assets.sources?.get(binding.source);
    if (
      !directory ||
      !safePath(binding.source) ||
      !binding.source.startsWith(directory + '/src/')
    ) {
      errors.push('replacement owner/source mismatch');
      continue;
    }
    if (binding.kind === 'binary-route') {
      if (!credentialIds.has(id) || source === undefined || !credentialRoute(binding, source))
        errors.push('unapproved or unregistered credential binary route');
      else targets.add('binary-route:' + binding.pathSymbol);
      continue;
    }
    if (
      !Array.isArray(binding.methods) ||
      !binding.methods.length ||
      new Set(binding.methods).size !== binding.methods.length
    ) {
      errors.push('replacement methods missing or duplicate');
      continue;
    }
    let declarations;
    if (binding.kind === undefined || binding.kind === 'remote') {
      if (binding.source.includes('/client/')) {
        errors.push('Client implementation is not an owning Remote');
        continue;
      }
      declarations =
        assets.remotes?.get(binding.source) ??
        (source === undefined ? undefined : remoteDeclarations(source));
      for (const method of binding.methods) {
        const target = binding.namespace + '.' + method;
        targets.add(target);
        if (!declarations?.has(target)) errors.push('not a public owning Remote: ' + target);
      }
      continue;
    }
    const policy = selected.find(
      (p) =>
        p.ids.includes(id) &&
        p.kind === binding.kind &&
        p.module === binding.module &&
        p.source === binding.source &&
        p.namespace === binding.namespace &&
        p.className === binding.className &&
        p.functionName === binding.functionName,
    );
    if (
      !policy ||
      source === undefined ||
      binding.methods.some((method) => !policy.methods.includes(method))
    ) {
      errors.push('unapproved infrastructure/Client boundary');
      continue;
    }
    declarations =
      binding.kind === 'service'
        ? serviceMethods(source, binding.className, binding.namespace)
        : clientServiceMethods(
            source,
            binding.functionName,
            binding.namespace,
            binding.source.endsWith('.tsx'),
          );
    for (const method of binding.methods) {
      targets.add(binding.namespace + '.' + method);
      if (!declarations.has(method))
        errors.push('missing real public/provided method ' + binding.namespace + '.' + method);
    }
  }
  return { errors, targets };
}
