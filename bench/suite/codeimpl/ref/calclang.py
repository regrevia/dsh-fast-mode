"""Reference implementation of the calclang fixture (used to validate the hidden tests)."""


class CalcError(ValueError):
    pass


OPS = '+-*/%(),'


def tokenize(source):
    out = []
    i = 0
    n = len(source)
    while i < n:
        c = source[i]
        if c in ' \t\n':
            i += 1
        elif c.isdigit():
            j = i
            while j < n and source[j].isdigit():
                j += 1
            out.append(('INT', int(source[i:j])))
            i = j
        elif c.isalpha() or c == '_':
            j = i
            while j < n and (source[j].isalnum() or source[j] == '_'):
                j += 1
            out.append(('NAME', source[i:j]))
            i = j
        elif c in OPS:
            out.append((c, c))
            i += 1
        else:
            raise CalcError(f'unexpected character: {c}')
    return out


class Parser:
    def __init__(self, tokens):
        self.tokens = list(tokens)
        self.pos = 0

    def peek(self):
        return self.tokens[self.pos] if self.pos < len(self.tokens) else None

    def take(self):
        tok = self.peek()
        if tok is None:
            raise CalcError('unexpected end of input')
        self.pos += 1
        return tok

    def parse(self):
        value = self.expr()
        tok = self.peek()
        if tok is not None:
            raise CalcError(f'unexpected token: {tok[1]}')
        return value

    def expr(self):
        value = self.term()
        while self.peek() is not None and self.peek()[0] in ('+', '-'):
            op = self.take()[0]
            rhs = self.term()
            value = value + rhs if op == '+' else value - rhs
        return value

    def term(self):
        value = self.unary()
        while self.peek() is not None and self.peek()[0] in ('*', '/', '%'):
            op = self.take()[0]
            rhs = self.unary()
            if op == '*':
                value = value * rhs
            elif op == '/':
                if rhs == 0:
                    raise CalcError('division by zero')
                if value % rhs != 0:
                    raise CalcError('division is not exact')
                value = value // rhs
            else:
                if rhs == 0:
                    raise CalcError('modulo by zero')
                value = value % rhs
        return value

    def unary(self):
        tok = self.peek()
        if tok is not None and tok[0] == '-':
            self.take()
            return -self.unary()
        return self.primary()

    def primary(self):
        tok = self.take()
        kind, value = tok
        if kind == 'INT':
            return value
        if kind == '(':
            inner = self.expr()
            nxt = self.take()
            if nxt[0] != ')':
                raise CalcError(f'unexpected token: {nxt[1]}')
            return inner
        if kind == 'NAME':
            nxt = self.peek()
            if nxt is not None and nxt[0] == '(':
                self.take()
                args = []
                if self.peek() is not None and self.peek()[0] != ')':
                    args.append(self.expr())
                    while self.peek() is not None and self.peek()[0] == ',':
                        self.take()
                        args.append(self.expr())
                close = self.take()
                if close[0] != ')':
                    raise CalcError(f'unexpected token: {close[1]}')
                return self.call(value, args)
            if value in self.env:
                return self.env[value]
            raise CalcError(f'unknown variable: {value}')
        raise CalcError(f'unexpected token: {value}')


class Evaluator(Parser):
    def __init__(self, tokens, env):
        super().__init__(tokens)
        self.env = dict(env or {})

    def call(self, name, args):
        if name == 'abs':
            if len(args) != 1:
                raise CalcError('bad arity: abs')
            return abs(args[0])
        if name in ('min', 'max'):
            if not args:
                raise CalcError(f'bad arity: {name}')
            return min(args) if name == 'min' else max(args)
        raise CalcError(f'unknown function: {name}')


def evaluate(source, env=None):
    tokens = tokenize(source)
    if not tokens:
        raise CalcError('unexpected end of input')
    return Evaluator(tokens, env).parse()
