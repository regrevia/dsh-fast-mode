"""Hidden acceptance tests for the codeimpl (calclang) fixture."""

import unittest

from calclang import CalcError, evaluate


class Arithmetic(unittest.TestCase):
    def test_precedence_and_associativity(self):
        self.assertEqual(evaluate('1 + 2 * 3'), 7)
        self.assertEqual(evaluate('1 + 2 - 3 + 4'), 4)
        self.assertEqual(evaluate('2 * 3 % 4'), 2)
        self.assertEqual(evaluate('(1 + 2) * 3'), 9)

    def test_unary_binds_tighter_than_multiply(self):
        self.assertEqual(evaluate('2 * -3'), -6)
        self.assertEqual(evaluate('-2 * 3'), -6)
        self.assertEqual(evaluate('2 - -3'), 5)
        self.assertEqual(evaluate('--4'), 4)
        self.assertEqual(evaluate('-(-2)'), 2)

    def test_divmod_follow_python_signs(self):
        self.assertEqual(evaluate('8 / 2'), 4)
        self.assertEqual(evaluate('-8 / 2'), -4)
        self.assertEqual(evaluate('-7 % 3'), 2)
        self.assertEqual(evaluate('7 % 3'), 1)

    def test_whitespace_and_multiline(self):
        self.assertEqual(evaluate(' \n 1\t+\n 2 '), 3)


class Names(unittest.TestCase):
    def test_variables(self):
        self.assertEqual(evaluate('x * 2', {'x': 4}), 8)
        self.assertEqual(evaluate('x - y', {'x': 10, 'y': 3}), 7)
        self.assertEqual(evaluate('_tmp + tmp2', {'_tmp': 1, 'tmp2': 2}), 3)

    def test_functions(self):
        self.assertEqual(evaluate('abs(-5)'), 5)
        self.assertEqual(evaluate('min(3, 1, 2)'), 1)
        self.assertEqual(evaluate('max(3, 1, 2)'), 3)
        self.assertEqual(evaluate('max(x, 4 * 2)', {'x': 3}), 8)
        self.assertEqual(evaluate('abs(min(1, -2) + max(3, -4))'), 1)

    def test_missing_names(self):
        with self.assertRaises(CalcError) as ctx:
            evaluate('nope')
        self.assertEqual(str(ctx.exception), 'unknown variable: nope')
        with self.assertRaises(CalcError) as ctx:
            evaluate('nope(1)')
        self.assertEqual(str(ctx.exception), 'unknown function: nope')


class Errors(unittest.TestCase):
    def test_exact_division_only(self):
        for source in ('7 / 2', '-7 / 2', '1 / 3'):
            with self.assertRaises(CalcError) as ctx:
                evaluate(source)
            self.assertEqual(str(ctx.exception), 'division is not exact')

    def test_zero_divisors(self):
        with self.assertRaises(CalcError) as ctx:
            evaluate('1 / 0')
        self.assertEqual(str(ctx.exception), 'division by zero')
        with self.assertRaises(CalcError) as ctx:
            evaluate('1 % 0')
        self.assertEqual(str(ctx.exception), 'modulo by zero')

    def test_bad_arity(self):
        with self.assertRaises(CalcError) as ctx:
            evaluate('abs(1, 2)')
        self.assertEqual(str(ctx.exception), 'bad arity: abs')
        with self.assertRaises(CalcError) as ctx:
            evaluate('max()')
        self.assertEqual(str(ctx.exception), 'bad arity: max')

    def test_syntax_errors(self):
        cases = {
            '1 +': 'unexpected end of input',
            '': 'unexpected end of input',
            '   ': 'unexpected end of input',
            '(1': 'unexpected end of input',
            '1)': 'unexpected token: )',
            '1 2': 'unexpected token: 2',
        }
        for source, message in cases.items():
            with self.assertRaises(CalcError) as ctx:
                evaluate(source)
            self.assertEqual(str(ctx.exception), message)

    def test_unexpected_character_names_it(self):
        with self.assertRaises(CalcError) as ctx:
            evaluate('1 $ 2')
        self.assertEqual(str(ctx.exception), 'unexpected character: $')

    def test_error_type_is_value_error_and_nothing_else_escapes(self):
        self.assertTrue(issubclass(CalcError, ValueError))
        for source in ('7 / 2', '(', 'x', '1 2', 'min()', '1 % 0', '@'):
            with self.assertRaises(ValueError):
                evaluate(source)

    def test_no_output_on_import(self):
        import contextlib, importlib, io, sys
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
            sys.modules.pop('calclang', None)
            importlib.import_module('calclang')
        self.assertEqual(buf.getvalue(), '')


if __name__ == '__main__':
    unittest.main()
