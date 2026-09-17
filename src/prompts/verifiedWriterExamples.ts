/** Neutral patterns executed by regression tests; never target output oracles. */
export interface WriterExample {
    id: string;
    feature: 'database' | 'async' | 'async-context' | 'class' | 'patch' | 'exception';
    source: string;
    tests: string;
}

export const VERIFIED_WRITER_EXAMPLES: readonly WriterExample[] = [
    {
        id: 'async-context-boundary-v1', feature: 'async-context',
        source: `async def load(client):
    async with client.open('fixture') as resource:
        return await resource.read()
`,
        tests: `import unittest
from unittest.mock import AsyncMock, MagicMock
from example_target import load
class Cases(unittest.IsolatedAsyncioTestCase):
    async def test_load(self):
        client = MagicMock()
        manager = client.open.return_value
        resource = manager.__aenter__.return_value
        resource.read = AsyncMock(return_value='controlled')
        self.assertEqual(await load(client), 'controlled')
        client.open.assert_called_once_with('fixture')
        resource.read.assert_awaited_once_with()
        manager.__aenter__.assert_awaited_once_with()
        manager.__aexit__.assert_awaited_once_with(None, None, None)
`
    },
    {
        id: 'sqlite-context-v1', feature: 'database',
        source: `import sqlite3
def load():
    with sqlite3.connect('example.db') as conn:
        return conn.execute('SELECT label FROM items').fetchone()
`,
        tests: `import unittest
from unittest.mock import patch
from example_target import load
class Cases(unittest.TestCase):
    def test_load(self):
        with patch('example_target.sqlite3.connect') as connect:
            conn = connect.return_value.__enter__.return_value
            conn.execute.return_value.fetchone.return_value = ('fixture',)
            self.assertEqual(load(), ('fixture',))
            conn.execute.assert_called_once_with('SELECT label FROM items')
        connect.return_value.__exit__.assert_called_once()
`
    },
    {
        id: 'async-boundary-v1', feature: 'async',
        source: `async def load(client):
    return await client.read('fixture')
`,
        tests: `import unittest
from unittest.mock import AsyncMock
from example_target import load
class Cases(unittest.IsolatedAsyncioTestCase):
    async def test_load(self):
        client = AsyncMock()
        client.read.return_value = 'controlled'
        self.assertEqual(await load(client), 'controlled')
        client.read.assert_awaited_once_with('fixture')
`
    },
    {
        id: 'instance-setup-v1', feature: 'class',
        source: `class Sender:
    def __init__(self, client):
        self.client = client
    def send(self, text):
        self.client.send(text)
`,
        tests: `import unittest
from unittest.mock import Mock
from example_target import Sender
class Cases(unittest.TestCase):
    def test_send(self):
        client = Mock()
        obj = Sender(client)
        self.assertIsNone(obj.send('fixture'))
        client.send.assert_called_once_with('fixture')
`
    },
    {
        id: 'patch-scope-v1', feature: 'patch',
        source: `def dependency():
    raise RuntimeError('boundary must be mocked')
def load():
    return dependency()
`,
        tests: `import unittest
from unittest.mock import patch
from example_target import load
class Cases(unittest.TestCase):
    def test_load(self):
        with patch('example_target.dependency', return_value='controlled') as dependency:
            self.assertEqual(load(), 'controlled')
            dependency.assert_called_once_with()
`
    },
    {
        id: 'controlled-exception-v1', feature: 'exception',
        source: `def dependency():
    raise RuntimeError('boundary must be mocked')
def load():
    return dependency()
`,
        tests: `import unittest
from unittest.mock import patch
from example_target import load
class Cases(unittest.TestCase):
    def test_load(self):
        with patch('example_target.dependency', side_effect=ValueError('controlled')) as dependency:
            with self.assertRaises(ValueError):
                load()
            dependency.assert_called_once_with()
`
    }
];

export function matchingWriterExamples(context: {
    is_async?: boolean; class_name?: string | null; calls?: string[];
    method_kind?: string;
    file_imports?: Array<{ module?: string; bound_name?: string; name?: string | null; alias?: string | null }>;
    raised_exceptions?: string[]; dependencyContexts?: unknown[];
    selectedRuleIds?: readonly string[];
}): readonly WriterExample[] {
    const features: WriterExample['feature'][] = [];
    const usedImports = (context.file_imports || []).filter(item => {
        const root = item.bound_name || item.alias || item.name || item.module?.split('.')[0];
        return root && context.calls?.some(call => call === root || call.startsWith(root + '.'));
    });
    if (context.is_async) {
        features.push(context.selectedRuleIds?.includes('async_context_manager_testing') ? 'async-context' : 'async');
    }
    if (usedImports.some(item => item.module === 'sqlite3')) { features.push('database'); }
    if (context.class_name && (!context.method_kind || context.method_kind === 'instance')) { features.push('class'); }
    if (usedImports.length || context.dependencyContexts?.length) {
        if (context.raised_exceptions?.length) { features.push('exception'); }
        features.push('patch');
    }
    return features.flatMap(feature => VERIFIED_WRITER_EXAMPLES.filter(item => item.feature === feature)).slice(0, 2);
}
