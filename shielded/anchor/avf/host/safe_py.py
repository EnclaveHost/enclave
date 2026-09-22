#!/usr/bin/env python3
"""A bounded interpreter for a small Python subset, so model-written code can be CHECKED without being RUN.

The previous approach ran candidate code in a child process with resource limits and a scratch cwd. An
audit showed that is not isolation -- a candidate wrote a file outside the scratch directory and still
passed -- and that the verdict, parsed from the child's stdout, was forgeable by the candidate itself.
Nothing short of a real sandbox (separate uid, mount and network namespaces, read-only filesystem, no
credentials, process-group kill) would fix the first, and a verdict channel outside the candidate's reach
would be needed for the second.

This file takes the other road: the candidate's source is PARSED, never executed. `ast.parse` builds a
tree without running anything, and this module walks that tree itself. There is no `exec`, no `eval`, no
`compile`, no `import` of candidate code, and no syscall the candidate can reach -- a candidate cannot
open a file, because `open` is not in the environment this interpreter provides, and it cannot forge a
verdict, because the verdict is the RETURN VALUE this interpreter computed, not something the candidate
printed.

Only the named function and other module-level `def`s it calls are interpreted. Module-level statements
are never evaluated at all, so `print(...); raise SystemExit(0)` sitting beside a function does nothing.

Anything outside the subset raises UnsupportedCode, and the caller reports REVIEW: "I could not evaluate
this" is a different answer from "this is wrong", and collapsing them would be the same mistake as
scoring a regex as correctness.
"""

import ast

MAX_STEPS = 200_000      # total statements+expressions evaluated, so `while True: pass` terminates
MAX_LEN = 100_000        # longest str/list any expression may produce, so 'a' * 10**9 cannot allocate
MAX_DEPTH = 20           # call nesting
MAX_POW = 64             # largest exponent


class UnsupportedCode(Exception):
    pass


class Bounded(Exception):
    pass


MAX_INT_BITS = 1 << 16   # integers may not grow past this many bits


def _size(v):
    return len(v) if isinstance(v, (str, list, tuple, bytes, set, dict)) else None


def _check_size(n, what):
    """Refuse BEFORE allocating. An audit built a 120000-element list past a 100000 limit because the
    check ran on the return value of `list.extend`, which is None, rather than on the growth itself."""
    if n is not None and n > MAX_LEN:
        raise Bounded("%s would reach %d elements, past %d" % (what, n, MAX_LEN))


def _check_int_bits(bits, what):
    if bits > MAX_INT_BITS:
        raise Bounded("%s would reach a %d-bit integer" % (what, bits))


SAFE_STR_METHODS = {"join", "split", "strip", "lower", "upper", "replace", "startswith", "endswith",
                    "find", "rfind", "rstrip", "lstrip", "isdigit", "isalpha", "count", "index", "title"}
SAFE_LIST_METHODS = {"append", "extend", "pop", "insert", "reverse", "sort", "index", "count"}
SAFE_BUILTINS = {"len", "range", "str", "int", "float", "list", "tuple", "reversed", "sorted", "abs",
                 "min", "max", "enumerate", "sum", "bool", "chr", "ord", "zip", "set", "dict", "any", "all"}

_BIN = {
    ast.Add: lambda a, b: a + b, ast.Sub: lambda a, b: a - b, ast.Mult: lambda a, b: a * b,
    ast.Div: lambda a, b: a / b, ast.FloorDiv: lambda a, b: a // b, ast.Mod: lambda a, b: a % b,
}
_CMP = {
    ast.Eq: lambda a, b: a == b, ast.NotEq: lambda a, b: a != b, ast.Lt: lambda a, b: a < b,
    ast.LtE: lambda a, b: a <= b, ast.Gt: lambda a, b: a > b, ast.GtE: lambda a, b: a >= b,
    ast.In: lambda a, b: a in b, ast.NotIn: lambda a, b: a not in b,
    ast.Is: lambda a, b: a is b, ast.IsNot: lambda a, b: a is not b,
}


class _Return(Exception):
    def __init__(self, v):
        self.value = v


class _Break(Exception):
    pass


class _Continue(Exception):
    pass


class Interp:
    def __init__(self, funcs):
        self.funcs = funcs
        self.steps = 0
        self.depth = 0

    def tick(self):
        self.steps += 1
        if self.steps > MAX_STEPS:
            raise Bounded("the code did not finish within %d steps" % MAX_STEPS)

    def precheck_bin(self, op, a, b):
        """Estimate the result BEFORE computing it. Covers both operand orders: `3 * "ab"` grows exactly
        as `"ab" * 3` does, and an earlier version only looked at the first."""
        sa, sb = _size(a), _size(b)
        if isinstance(op, ast.Mult):
            if sa is not None and isinstance(b, int):
                _check_size(sa * max(b, 0), "repetition")
            elif sb is not None and isinstance(a, int):
                _check_size(sb * max(a, 0), "repetition")
            elif isinstance(a, int) and isinstance(b, int):
                _check_int_bits(a.bit_length() + b.bit_length(), "multiplication")
        elif isinstance(op, ast.Add):
            if sa is not None and sb is not None:
                _check_size(sa + sb, "concatenation")
            elif isinstance(a, int) and isinstance(b, int):
                _check_int_bits(max(a.bit_length(), b.bit_length()) + 1, "addition")

    def precheck_method(self, obj, attr, args):
        """The growing str and list methods, checked before they run rather than after."""
        n = _size(obj)
        if attr == "append" and n is not None:
            _check_size(n + 1, "append")
        elif attr == "extend" and n is not None:
            _check_size(n + (_size(args[0]) if args and _size(args[0]) is not None else 1), "extend")
        elif attr == "insert" and n is not None:
            _check_size(n + 1, "insert")
        elif attr == "join" and isinstance(obj, str) and args:
            parts = args[0]
            if isinstance(parts, (list, tuple)):
                total = sum(_size(x) or 0 for x in parts) + len(obj) * max(len(parts) - 1, 0)
                _check_size(total, "join")
        elif attr == "replace" and isinstance(obj, str) and len(args) >= 2:
            old, new = args[0], args[1]
            if isinstance(old, str) and isinstance(new, str):
                grow = len(new) - len(old)
                cnt = obj.count(old) if old else len(obj) + 1
                _check_size(len(obj) + max(grow, 0) * cnt, "replace")

    def guard(self, v):
        if isinstance(v, (str, list, tuple, bytes, set, dict)) and len(v) > MAX_LEN:
            raise Bounded("a value grew past %d elements" % MAX_LEN)
        # integers were never bounded here, so anything the pre-checks did not anticipate slipped through
        if isinstance(v, int) and not isinstance(v, bool):
            _check_int_bits(v.bit_length(), "a value")
        return v

    # ---- statements -------------------------------------------------------
    def block(self, body, env):
        for st in body:
            self.stmt(st, env)

    def stmt(self, n, env):
        self.tick()
        if isinstance(n, ast.Return):
            raise _Return(self.expr(n.value, env) if n.value is not None else None)
        if isinstance(n, ast.Assign):
            v = self.expr(n.value, env)
            for t in n.targets:
                self.assign(t, v, env)
            return
        if isinstance(n, ast.AugAssign):
            cur = self.expr(n.target, env) if isinstance(n.target, (ast.Name, ast.Subscript)) else None
            op = _BIN.get(type(n.op))
            if op is None:
                raise UnsupportedCode("augmented operator %s" % type(n.op).__name__)
            # `x *= x` in a loop reached a 131073-bit integer because this path skipped the pre-check that
            # the plain binary operator already had. Augmented assignment is the same arithmetic.
            rhs = self.expr(n.value, env)
            self.precheck_bin(n.op, cur, rhs)
            self.assign(n.target, self.guard(op(cur, rhs)), env)
            return
        if isinstance(n, ast.AnnAssign):
            if n.value is not None:
                self.assign(n.target, self.expr(n.value, env), env)
            return
        if isinstance(n, ast.If):
            self.block(n.body if self.expr(n.test, env) else n.orelse, env)
            return
        if isinstance(n, ast.While):
            while self.expr(n.test, env):
                self.tick()
                try:
                    self.block(n.body, env)
                except _Break:
                    break
                except _Continue:
                    continue
            else:
                self.block(n.orelse, env)
            return
        if isinstance(n, ast.For):
            it = self.expr(n.iter, env)
            try:
                seq = list(it)
            except TypeError:
                raise UnsupportedCode("that loop target is not iterable here")
            if len(seq) > MAX_LEN:
                raise Bounded("loop over %d items" % len(seq))
            broke = False
            for item in seq:
                self.tick()
                self.assign(n.target, item, env)
                try:
                    self.block(n.body, env)
                except _Break:
                    broke = True
                    break
                except _Continue:
                    continue
            if not broke:
                self.block(n.orelse, env)
            return
        if isinstance(n, ast.Expr):
            self.expr(n.value, env)
            return
        if isinstance(n, ast.Pass):
            return
        if isinstance(n, ast.Break):
            raise _Break()
        if isinstance(n, ast.Continue):
            raise _Continue()
        if isinstance(n, ast.FunctionDef):
            # A nested def binds LOCALLY. Putting it in the module table let a later `rev = 0` in the same
            # body be ignored at the call site, so `rev(s)` still reached the function where real Python
            # raises TypeError: 'int' object is not callable.
            env[n.name] = ("__fn__", n)
            return
        raise UnsupportedCode("statement %s" % type(n).__name__)

    def assign(self, t, v, env):
        if isinstance(t, ast.Name):
            env[t.id] = self.guard(v)
            return
        if isinstance(t, ast.Subscript):
            obj = self.expr(t.value, env)
            if not isinstance(obj, (list, dict)):
                raise UnsupportedCode("assigning into a %s" % type(obj).__name__)
            obj[self.expr(t.slice, env)] = v
            return
        if isinstance(t, (ast.Tuple, ast.List)):
            vals = list(v)
            if len(vals) != len(t.elts):
                raise UnsupportedCode("unpacking mismatch")
            for sub, sv in zip(t.elts, vals):
                self.assign(sub, sv, env)
            return
        raise UnsupportedCode("assignment target %s" % type(t).__name__)

    # ---- expressions ------------------------------------------------------
    def expr(self, n, env):
        self.tick()
        if isinstance(n, ast.Constant):
            return n.value
        if isinstance(n, ast.Name):
            if n.id in env:
                return env[n.id]
            if n.id in self.funcs:
                return ("__fn__", self.funcs[n.id])
            if n.id in SAFE_BUILTINS:
                return ("__builtin__", n.id)
            raise UnsupportedCode("name %r is not available here" % n.id)
        if isinstance(n, ast.BinOp):
            a, b = self.expr(n.left, env), self.expr(n.right, env)
            if isinstance(n.op, ast.Pow):
                if not isinstance(b, int) or b > MAX_POW or b < 0:
                    raise Bounded("exponent out of range")
                if isinstance(a, int) and a.bit_length() * max(b, 1) > MAX_INT_BITS:
                    raise Bounded("exponentiation would reach a %d-bit integer" % (a.bit_length() * b))
                return self.guard(a ** b)
            op = _BIN.get(type(n.op))
            if op is None:
                raise UnsupportedCode("operator %s" % type(n.op).__name__)
            self.precheck_bin(n.op, a, b)
            return self.guard(op(a, b))
        if isinstance(n, ast.UnaryOp):
            v = self.expr(n.operand, env)
            if isinstance(n.op, ast.USub):
                return -v
            if isinstance(n.op, ast.UAdd):
                return +v
            if isinstance(n.op, ast.Not):
                return not v
            raise UnsupportedCode("unary %s" % type(n.op).__name__)
        if isinstance(n, ast.BoolOp):
            if isinstance(n.op, ast.And):
                v = True
                for x in n.values:
                    v = self.expr(x, env)
                    if not v:
                        return v
                return v
            v = False
            for x in n.values:
                v = self.expr(x, env)
                if v:
                    return v
            return v
        if isinstance(n, ast.Compare):
            left = self.expr(n.left, env)
            for op, cmp in zip(n.ops, n.comparators):
                f = _CMP.get(type(op))
                if f is None:
                    raise UnsupportedCode("comparison %s" % type(op).__name__)
                right = self.expr(cmp, env)
                if not f(left, right):
                    return False
                left = right
            return True
        if isinstance(n, ast.IfExp):
            return self.expr(n.body if self.expr(n.test, env) else n.orelse, env)
        if isinstance(n, ast.List):
            return self.guard([self.expr(e, env) for e in n.elts])
        if isinstance(n, ast.Tuple):
            return tuple(self.expr(e, env) for e in n.elts)
        if isinstance(n, ast.Dict):
            return {self.expr(k, env): self.expr(v, env) for k, v in zip(n.keys, n.values)}
        if isinstance(n, ast.JoinedStr):
            out = []
            for p in n.values:
                out.append(p.value if isinstance(p, ast.Constant) else str(self.expr(p.value, env)))
            return self.guard("".join(out))
        if isinstance(n, ast.FormattedValue):
            return str(self.expr(n.value, env))
        if isinstance(n, ast.Slice):
            return slice(self.expr(n.lower, env) if n.lower else None,
                         self.expr(n.upper, env) if n.upper else None,
                         self.expr(n.step, env) if n.step else None)
        if isinstance(n, ast.Subscript):
            return self.guard(self.expr(n.value, env)[self.expr(n.slice, env)])
        if isinstance(n, ast.ListComp):
            return self.guard(self.listcomp(n, env))
        if isinstance(n, ast.Call):
            return self.call(n, env)
        if isinstance(n, ast.Attribute):
            raise UnsupportedCode("attribute access outside a method call")
        raise UnsupportedCode("expression %s" % type(n).__name__)

    def listcomp(self, n, env):
        if len(n.generators) != 1 or n.generators[0].is_async:
            raise UnsupportedCode("only a single simple comprehension")
        g = n.generators[0]
        out = []
        for item in list(self.expr(g.iter, env)):
            self.tick()
            local = dict(env)
            self.assign(g.target, item, local)
            if all(self.expr(c, local) for c in g.ifs):
                out.append(self.expr(n.elt, local))
            if len(out) > MAX_LEN:
                raise Bounded("comprehension past %d elements" % MAX_LEN)
        return out

    def call(self, n, env):
        if n.keywords:
            raise UnsupportedCode("keyword arguments")
        args = [self.expr(a, env) for a in n.args]
        f = n.func
        if isinstance(f, ast.Attribute):                     # a method call on a value we produced
            obj = self.expr(f.value, env)
            allowed = SAFE_STR_METHODS if isinstance(obj, str) else (
                SAFE_LIST_METHODS if isinstance(obj, list) else set())
            if f.attr not in allowed:
                raise UnsupportedCode("method %s.%s" % (type(obj).__name__, f.attr))
            self.precheck_method(obj, f.attr, args)
            r = getattr(obj, f.attr)(*args)
            self.guard(obj)          # the RECEIVER is what a mutating method grew, not its return value
            return self.guard(r)
        if isinstance(f, ast.Name):
            if f.id in env:                       # a local binding SHADOWS the module-level def
                v = env[f.id]
                if isinstance(v, tuple) and len(v) == 2 and v[0] == "__fn__":
                    return self.invoke(v[1], args)
                raise UnsupportedCode("%r is bound to a %s here, which Python would refuse to call"
                                      % (f.id, type(v).__name__))
            if f.id in self.funcs:
                return self.invoke(self.funcs[f.id], args)
            if f.id in SAFE_BUILTINS:
                if f.id == "reversed":
                    return list(reversed(args[0]))
                if f.id == "range":
                    r = range(*args)
                    if len(r) > MAX_LEN:
                        raise Bounded("range of %d" % len(r))
                    return r
                return self.guard(__builtins__["__import__"]("builtins").__dict__[f.id](*args)
                                  if isinstance(__builtins__, dict) else getattr(__builtins__, f.id)(*args))
            raise UnsupportedCode("call to %r" % f.id)
        raise UnsupportedCode("calling a %s" % type(f).__name__)

    def invoke(self, fn, args):
        if self.depth >= MAX_DEPTH:
            raise Bounded("call nesting past %d" % MAX_DEPTH)
        a = fn.args
        if a.vararg or a.kwarg or a.kwonlyargs or a.posonlyargs:
            raise UnsupportedCode("only plain positional parameters")
        names = [x.arg for x in a.args]
        defaults = [self.expr(d, {}) for d in a.defaults]
        if len(args) < len(names) - len(defaults) or len(args) > len(names):
            raise UnsupportedCode("called %s with %d arguments" % (fn.name, len(args)))
        env = dict(zip(names, list(args) + defaults[len(args) - len(names):] if defaults else args))
        self.depth += 1
        try:
            self.block(fn.body, env)
            return None
        except _Return as r:
            return r.value
        finally:
            self.depth -= 1


def call_function(src, name, args):
    """Interpret `name(*args)` from `src`. Raises UnsupportedCode / Bounded; never executes anything."""
    try:
        tree = ast.parse(src)
    except SyntaxError as e:
        raise UnsupportedCode("not valid Python: %s" % e)
    funcs = {n.name: n for n in tree.body if isinstance(n, ast.FunctionDef)}
    if name not in funcs:
        raise UnsupportedCode("no function named %r is defined" % name)
    it = Interp(funcs)
    try:
        return it.invoke(funcs[name], list(args))
    except Bounded as e:
        raise UnsupportedCode(str(e))
    except (_Break, _Continue):
        raise UnsupportedCode("break or continue outside a loop")
    except UnsupportedCode:
        raise
    except Exception as e:
        raise UnsupportedCode("raised %s: %s" % (type(e).__name__, e))
