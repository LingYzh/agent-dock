import assert from 'node:assert/strict';
import { linkTarget } from './link-target.mjs';
assert.equal(linkTarget('https://example.com/a?q=1#b'), 'https://example.com/a?q=1#b');
assert.equal(linkTarget('mailto:dev@example.com'), 'mailto:dev@example.com');
assert.equal(linkTarget('E:\\Project\\a b.md'), 'file:///E:/Project/a%20b.md');
assert.equal(linkTarget('/E:/Project/a.md'), 'file:///E:/Project/a.md');
assert.equal(linkTarget('file:///E:/Project/a.md'), 'file:///E:/Project/a.md');
for (const value of ['javascript:alert(1)', 'data:text/html,a', '//example.com', '\\\\host\\share', 'file://host/share', 'file:////host/share', 'relative.md']) {
    assert.equal(linkTarget(value), null, value);
}
console.log(JSON.stringify({ passed: true, webMailAndLocalLinks: true, executableAndNetworkShareLinksRejected: true }));
