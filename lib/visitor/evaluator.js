
/*!
 * CSS - Evaluator
 * Copyright(c) 2010 LearnBoost <dev@learnboost.com>
 * MIT Licensed
 */

/**
 * Module dependencies.
 */

var Visitor = require('./')
  , nodes = require('../nodes')
  , Stack = require('../stack')
  , Frame = require('../stack/frame')
  , Scope = require('../stack/scope')
  , utils = require('../utils')
  , bifs = require('../functions')
  , dirname = require('path').dirname
  , fs = require('fs');

/**
 * Initialize a new `Evaluator` with the given `root` Node
 * and the following `options`.
 *
 * Options:
 *
 *   - `compress`  Compress the css output, defaults to false
 *
 * @param {Node} root
 * @api public
 */

var Evaluator = module.exports = function Evaluator(root, options) {
  options = options || {};
  Visitor.call(this, root);
  this.stack = new Stack(this);
  this.filename = options.filename;
  this.functions = options.functions || {};
  this.paths = options.paths || [];
  this.paths.push(dirname(options.filename || '.'));
  this.stack.push(this.global = new Frame(root));
};

/**
 * Inherit from `Visitor.prototype`.
 */

Evaluator.prototype.__proto__ = Visitor.prototype;

/**
 * Proxy visit to expose node line numbers.
 *
 * @param {Node} node
 * @return {Node}
 * @api public
 */

var visit = Visitor.prototype.visit;
Evaluator.prototype.visit = function(node){
  try {
    this.lineno = node.lineno;
    return visit.call(this, node);
  } catch (err) {
    // TODO: less-lame hack to reference
    // the origin node source input
    err.str = err.str || node.source;
    err.stylusStack = err.stylusStack || this.stack.toString();
    throw err;
  }
};

/**
 * Evaluate the tree.
 *
 * @return {Node}
 * @api public
 */

Evaluator.prototype.evaluate = function(){
  return this.visit(this.root);
};

/**
 * Visit Color.
 */

Evaluator.prototype.visitColor = function(color){
  return color;
};

/**
 * Visit HSLA.
 */

Evaluator.prototype.visitHSLA = function(hsla){
  return hsla;
};

/**
 * Visit Literal.
 */

Evaluator.prototype.visitLiteral = function(lit){
  return lit;
};

/**
 * Visit Boolean.
 */

Evaluator.prototype.visitBoolean = function(bool){
  return bool;
};

/**
 * Visit Unit.
 */

Evaluator.prototype.visitUnit = function(unit){
  return unit;
};

/**
 * Visit String.
 */

Evaluator.prototype.visitString = function(string){
  return string;
};

/**
 * Visit Null.
 */

Evaluator.prototype.visitNull = function(node){
  return node;
};

/**
 * Visit Function.
 */

Evaluator.prototype.visitFunction = function(fn){
  return fn;
};

/**
 * Visit Group.
 */

Evaluator.prototype.visitGroup = function(group){
  for (var i = 0, len = group.nodes.length; i < len; ++i) {
    group.nodes[i] = this.visit(group.nodes[i]);
  }
  return group;
};


/**
 * Visit Selector.
 */

Evaluator.prototype.visitSelector = function(selector){
  selector.block = this.visit(selector.block);
  return selector;
};

/**
 * Visit Charset.
 */

Evaluator.prototype.visitCharset = function(charset){
  return charset;
};

/**
 * Visit Call.
 */

Evaluator.prototype.visitCall = function(call){
  var fn = this.lookupFunction(call.name);

  // Undefined function, render literal css
  if (!fn) return this.literalCall(call);
  this.calling = call.name;

  // First node in expression
  // TODO: remove?
  if (fn instanceof nodes.Expression) {
    fn = fn.first;
  }

  // Evaluate arguments
  var _ = this.return;
  this.return = true;
  var args = this.visit(call.args);
  this.return = _;

  // Built-in
  if ('function' == typeof fn) {
    return this.invokeBuiltin(fn, args);
  // User-defined
  } else if (fn instanceof nodes.Function) {
    return this.invokeFunction(fn, args);
  }
};

/**
 * Visit Ident.
 */

Evaluator.prototype.visitIdent = function(ident){
  // Lookup
  if (nodes.null == ident.val) {
    var val = this.stack.lookup(ident.name);
    return val ? this.visit(val) : ident;
  // Assign  
  } else {
    var _ = this.return;
    this.return = true;
    ident.val = this.visit(ident.val);
    this.return = _;
    this.stack.currentFrame.scope.add(ident);
    return ident.val;
  }
};

/**
 * Visit BinOp.
 */

Evaluator.prototype.visitBinOp = function(binop){
  // Special-case "is defined" pseudo binop
  if ('is defined' == binop.op) return this.isDefined(binop.left);

  var _ = this.return;
  this.return = true;
  // Visit operands
  var op = binop.op
    , left = this.visit(binop.left).first
    , right = this.visit(binop.right).first;
  this.return = _;

  // Coercion
  var ignore = ['||', '&&', 'is a'];
  if (!~ignore.indexOf(op)) {
    right = left.coerce(right);
  }

  // Operate
  return this.visit(left.operate(op, right));
};

/**
 * Visit UnaryOp.
 */

Evaluator.prototype.visitUnaryOp = function(unary){
  var op = unary.op
    , node = this.visit(unary.expr).first;

  if ('!' != op) utils.assertType(node, nodes.Unit);

  switch (op) {
    case '-':
      node.val = -node.val;
      break;
    case '+':
      node.val = +node.val;
      break;
    case '~':
      node.val = ~node.val;
      break;
    case '!':
      return node.toBoolean().negate();
  }
  
  return node;
};

/**
 * Visit TernaryOp.
 */

Evaluator.prototype.visitTernary = function(ternary){
  var ok = this.visit(ternary.cond).toBoolean();
  return nodes.true == ok
    ? this.visit(ternary.trueExpr)
    : this.visit(ternary.falseExpr);
};

/**
 * Visit Expression.
 */

Evaluator.prototype.visitExpression = function(expr){
  for (var i = 0, len = expr.nodes.length; i < len; ++i) {
    expr.nodes[i] = this.visit(expr.nodes[i]);
  }
  return expr;
};

/**
 * Visit Property.
 */

Evaluator.prototype.visitProperty = function(prop){
  var fn = this.stack.lookup(prop.name)
    , call = fn instanceof nodes.Function
    , literal = prop.name == this.calling;

  // Function of the same name
  if (call && !literal) {
    this.calling = prop.name;
    var ret = this.visit(new nodes.Call(prop.name, prop.expr));
    this.calling = null;
    return ret;
  // Regular property
  } else {
    var _ = this.return;
    this.return = true;
    prop.expr = this.visit(prop.expr);
    this.return = _;
    return prop;
  }
};

/**
 * Visit Root.
 */

Evaluator.prototype.visitRoot = function(block){
  for (var i = 0; i < block.nodes.length; ++i) {
    this.rootIndex = i;
    block.nodes[i] = this.visit(block.nodes[i]);
  }
  return block;
};

/**
 * Visit Block.
 */

Evaluator.prototype.visitBlock = function(block){
  this.stack.push(new Frame(block));
  for (var i = 0, len = block.nodes.length; i < len; ++i) {
    block.nodes[i] = this.visit(block.nodes[i]);
  }
  this.stack.pop();
  return block;
};

/**
 * Visit Import.
 */

Evaluator.prototype.visitImport = function(import){
  var found
    , root = this.root
    , i = this.rootIndex
    , stylus = require('../stylus')
    , path = import.path
    , relative = this.importPath;

  // Literal
  if (/\.css$/.test(path)) return import;
  path += '.styl';

  // Lookup
  if (relative) this.paths.push(relative);
  found = utils.lookup(path, this.paths);
  if (relative) this.paths.pop();

  // Throw if import failed
  if (!found) throw new Error('failed to locate @import file ' + path);
  this.importPath = dirname(found);

  // Parse the file
  var str = fs.readFileSync(found, 'utf8')
    , rest = root.nodes.splice(++i, root.nodes.length);

  stylus.parse(str, {
      filename: found
    , root: root
  });

  rest.forEach(function(node){
    root.push(node);
  });

  return nodes.null;
};

/**
 * Invoke `fn` with `args`.
 *
 * @param {Function} fn
 * @param {Array} args
 * @return {Node}
 * @api public
 */

Evaluator.prototype.invokeFunction = function(fn, args){
  // Clone the function body
  // to prevent mutation of subsequent calls
  var body = fn.block.clone();

  // Inject argument scope
  var block = new nodes.Block(body.parent);
  body.parent = block;

  // Inject arguments as locals
  this.stack.push(new Frame(block));
  fn.params.nodes.forEach(function(node, i){
    // Argument default support
    var val = args.nodes[i] || node.val;
    node = node.clone();
    node.val = val;

    // Required argument not satisfied
    if (node.val instanceof nodes.Null) {
      throw new Error('argument ' + node + ' required for ' + fn);
    }
    this.stack.currentFrame.scope.add(node);
  }, this);

  // Evaluate
  body = this.visit(body);
  this.stack.pop();

  // Invoke
  return this.invoke(body);
};

/**
 * Invoke built-in `fn` with `args`.
 *
 * @param {Function} fn
 * @param {Array} args
 * @return {Node}
 * @api public
 */

Evaluator.prototype.invokeBuiltin = function(fn, args){
  // Map arguments to first node
  // providing a nicer js api for
  // BIFs
  args = args.nodes.map(function(node){
    return node.first;
  });

  // Invoke the BIF
  body = fn.apply(this, args);

  // Wrap non-expressions as an Expression,
  // again just providing a nicer api
  // to work with.
  if (!(body instanceof nodes.Expression)) {
    var expr = new nodes.Expression;
    expr.push(body);
    body = expr;
  }

  // Invoke
  return this.invoke(body);
};

/**
 * Invoke the given function `body`.
 *
 * @param {Block} body
 * @return {Node}
 * @api public
 */

Evaluator.prototype.invoke = function(body){
  // Return
  if (this.return) {
    return body.nodes[body.nodes.length - 1];
  // Mixin
  } else {
    body.nodes.forEach(function(node){
      this.stack.currentFrame.block.nodes.push(node);
    }, this);
    return nodes.null;
  }
};

/**
 * Literal function `call`.
 *
 * @param {Call} call
 * @return {call}
 * @api public
 */

Evaluator.prototype.literalCall = function(call){
  call.args = this.visit(call.args);
  return call;
};

/**
 * Lookup function by the given `name`.
 *
 * @param {String} name
 * @return {Function}
 * @api public
 */

Evaluator.prototype.lookupFunction = function(name){
  return this.stack.lookup(name)
    || this.functions[name]
    || bifs[name];
};

/**
 * Check if the given `node` is an ident, and if it is defined.
 *
 * @param {Node} node
 * @return {Boolean}
 * @api private
 */

Evaluator.prototype.isDefined = function(node){
  if (node instanceof nodes.Ident) {
    return nodes.Boolean(this.stack.lookup(node.name));
  } else {
    throw new Error('invalid "is defined" check on non-variable ' + node);
  }
};