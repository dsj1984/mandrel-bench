/**
 * tests/bench/scenarios/security-adapter.test.js
 *
 * Unit tests for bench/scenarios/security-adapter.js (Epic #32, Story #37).
 *
 * All I/O is fully stubbed — no filesystem access, no child processes. Every
 * test verifies a deterministic sub-signal object from the adapter given a
 * fixture workspace driven through injected ports.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { collectSecuritySignals } from '../../../bench/scenarios/security-adapter.js';

// ---------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal fsImpl stub from a map of { absolutePath → fileContent }.
 * readdirSync returns synthetic DirEntry objects derived from the path map.
 * readFileSync returns the file content for known paths, throws for unknown.
 * statSync is not used by the adapter (readdirSync uses withFileTypes).
 *
 * @param {Record<string, string>} files  — { path: content }
 * @param {string} root  — the workspace root path
 * @returns {object}  fsImpl stub
 */
function makeFs(files, root) {
  // Build a directory tree from the flat file map
  const dirs = new Map(); // dirPath → [DirEntry]

  for (const filePath of Object.keys(files)) {
    const parts = filePath.slice(root.length).split('/').filter(Boolean);
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const isLast = i === parts.length - 1;
      if (!dirs.has(current)) dirs.set(current, []);
      const entries = dirs.get(current);
      if (!entries.some((e) => e.name === name)) {
        entries.push({
          name,
          isDirectory: () => !isLast,
          isFile: () => isLast,
        });
      }
      if (!isLast) {
        current = `${current}/${name}`;
      }
    }
  }

  return {
    readdirSync(dirPath, _opts) {
      return dirs.get(dirPath) ?? [];
    },
    readFileSync(filePath, _encoding) {
      if (Object.hasOwn(files, filePath)) {
        return files[filePath];
      }
      const err = new Error(
        `ENOENT: no such file or directory, open '${filePath}'`,
      );
      err.code = 'ENOENT';
      throw err;
    },
  };
}

/**
 * Build a minimal execFileSync stub that returns `auditJson` as if `npm audit
 * --json` succeeded (exit 0). Pass `{ throws: true, stdout: json }` to
 * simulate a non-zero exit with JSON still on stdout (the real npm audit
 * behaviour when vulns are found).
 *
 * @param {string|null} auditJson
 * @param {{ throws?: boolean }} [opts]
 * @returns {Function}
 */
function makeExec(auditJson, { throws = false } = {}) {
  return (_cmd, _args, _opts) => {
    if (throws) {
      const err = new Error('npm audit exited with code 1');
      err.stdout = auditJson ?? '';
      throw err;
    }
    return auditJson ?? '';
  };
}

const ROOT = '/workspace';

// ---------------------------------------------------------------------------
// Fixture: a clean workspace with no signals
// ---------------------------------------------------------------------------

const CLEAN_FILES = {
  [`${ROOT}/index.js`]: `
    // A simple server with no interesting patterns
    import express from 'express';
    const app = express();
    app.get('/', (req, res) => res.send('hello'));
    app.listen(3000);
  `,
};

const CLEAN_AUDIT = JSON.stringify({
  metadata: { vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 0 } },
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('collectSecuritySignals — shape and determinism', () => {
  it('returns the expected sub-signal keys and types', () => {
    const signals = collectSecuritySignals(ROOT, {
      fsImpl: makeFs(CLEAN_FILES, ROOT),
      execFileSync: makeExec(CLEAN_AUDIT),
    });

    assert.equal(typeof signals.secretScanCount, 'number');
    assert.equal(typeof signals.depAuditVulnCount, 'number');
    assert.equal(typeof signals.hasEdgeInputValidation, 'boolean');
    assert.equal(typeof signals.hasPasswordHashing, 'boolean');
    assert.equal(typeof signals.hasSafeTokenStorage, 'boolean');
    assert.equal(typeof signals.hasServerSideAuthz, 'boolean');
    assert.equal(typeof signals.hasAuthRateLimiting, 'boolean');
  });

  it('is deterministic — identical inputs yield identical output', () => {
    const a = collectSecuritySignals(ROOT, {
      fsImpl: makeFs(CLEAN_FILES, ROOT),
      execFileSync: makeExec(CLEAN_AUDIT),
    });
    const b = collectSecuritySignals(ROOT, {
      fsImpl: makeFs(CLEAN_FILES, ROOT),
      execFileSync: makeExec(CLEAN_AUDIT),
    });
    assert.deepEqual(a, b);
  });

  it('returns all-zero / all-false for a clean workspace', () => {
    const signals = collectSecuritySignals(ROOT, {
      fsImpl: makeFs(CLEAN_FILES, ROOT),
      execFileSync: makeExec(CLEAN_AUDIT),
    });

    assert.equal(signals.secretScanCount, 0);
    assert.equal(signals.depAuditVulnCount, 0);
    assert.equal(signals.hasEdgeInputValidation, false);
    assert.equal(signals.hasPasswordHashing, false);
    assert.equal(signals.hasSafeTokenStorage, false);
    assert.equal(signals.hasServerSideAuthz, false);
    assert.equal(signals.hasAuthRateLimiting, false);
  });
});

describe('collectSecuritySignals — secret scan', () => {
  it('counts a hardcoded API key assignment', () => {
    const files = {
      [`${ROOT}/config.js`]: `const apiKey = 'sk-abcdefgh1234567890xyz';`,
    };
    const signals = collectSecuritySignals(ROOT, {
      fsImpl: makeFs(files, ROOT),
      execFileSync: makeExec(CLEAN_AUDIT),
    });
    assert.ok(signals.secretScanCount > 0, 'should detect the hardcoded key');
  });

  it('counts an AWS access key ID', () => {
    const files = {
      [`${ROOT}/deploy.js`]: `const keyId = 'AKIAIOSFODNN7EXAMPLE';`,
    };
    const signals = collectSecuritySignals(ROOT, {
      fsImpl: makeFs(files, ROOT),
      execFileSync: makeExec(CLEAN_AUDIT),
    });
    assert.ok(signals.secretScanCount > 0, 'should detect the AWS key');
  });

  it('never exposes the secret value — only the count', () => {
    const SECRET = 'super-secret-token-12345678';
    const files = {
      [`${ROOT}/env.js`]: `const secretKey = '${SECRET}';`,
    };
    const signals = collectSecuritySignals(ROOT, {
      fsImpl: makeFs(files, ROOT),
      execFileSync: makeExec(CLEAN_AUDIT),
    });
    // The secret string must not appear anywhere in the returned object
    const json = JSON.stringify(signals);
    assert.ok(!json.includes(SECRET), 'secret value must not appear in output');
    assert.equal(typeof signals.secretScanCount, 'number');
  });

  it('returns 0 for a placeholder-only .env file', () => {
    const files = {
      [`${ROOT}/.env`]: `API_KEY=your-api-key-here\nSECRET=replace-me`,
    };
    const signals = collectSecuritySignals(ROOT, {
      fsImpl: makeFs(files, ROOT),
      execFileSync: makeExec(CLEAN_AUDIT),
    });
    // Placeholders (< 8 chars or descriptive words) should not match
    assert.equal(signals.secretScanCount, 0);
  });
});

describe('collectSecuritySignals — dependency audit', () => {
  it('sums vulnerabilities from npm audit --json (v7 shape)', () => {
    const auditJson = JSON.stringify({
      metadata: {
        vulnerabilities: { critical: 2, high: 3, moderate: 1, low: 0 },
      },
    });
    const signals = collectSecuritySignals(ROOT, {
      fsImpl: makeFs(CLEAN_FILES, ROOT),
      execFileSync: makeExec(auditJson),
    });
    assert.equal(signals.depAuditVulnCount, 6); // 2+3+1+0
  });

  it('reads vuln count from err.stdout when npm audit exits non-zero', () => {
    const auditJson = JSON.stringify({
      metadata: {
        vulnerabilities: { critical: 1, high: 0, moderate: 2, low: 4 },
      },
    });
    const signals = collectSecuritySignals(ROOT, {
      fsImpl: makeFs(CLEAN_FILES, ROOT),
      execFileSync: makeExec(auditJson, { throws: true }),
    });
    assert.equal(signals.depAuditVulnCount, 7); // 1+0+2+4
  });

  it('returns 0 when npm audit output is not parseable JSON', () => {
    const signals = collectSecuritySignals(ROOT, {
      fsImpl: makeFs(CLEAN_FILES, ROOT),
      execFileSync: makeExec('not json at all'),
    });
    assert.equal(signals.depAuditVulnCount, 0);
  });

  it('returns 0 when execFileSync throws with no stdout', () => {
    const execFileSync = () => {
      throw new Error('ENOENT: npm not found');
    };
    const signals = collectSecuritySignals(ROOT, {
      fsImpl: makeFs(CLEAN_FILES, ROOT),
      execFileSync,
    });
    assert.equal(signals.depAuditVulnCount, 0);
  });
});

describe('collectSecuritySignals — baseline MUST booleans', () => {
  it('detects zod as edge input validation', () => {
    const files = {
      [`${ROOT}/routes/user.js`]: `import { z } from 'zod';\nconst schema = z.object({ name: z.string() });`,
    };
    const signals = collectSecuritySignals(ROOT, {
      fsImpl: makeFs(files, ROOT),
      execFileSync: makeExec(CLEAN_AUDIT),
    });
    assert.equal(signals.hasEdgeInputValidation, true);
  });

  it('detects joi as edge input validation', () => {
    const files = {
      [`${ROOT}/validate.js`]: `const Joi = require('joi');`,
    };
    const signals = collectSecuritySignals(ROOT, {
      fsImpl: makeFs(files, ROOT),
      execFileSync: makeExec(CLEAN_AUDIT),
    });
    assert.equal(signals.hasEdgeInputValidation, true);
  });

  it('detects bcrypt as password hashing', () => {
    const files = {
      [`${ROOT}/auth.js`]: `import bcrypt from 'bcrypt';\nconst hash = await bcrypt.hash(pw, 12);`,
    };
    const signals = collectSecuritySignals(ROOT, {
      fsImpl: makeFs(files, ROOT),
      execFileSync: makeExec(CLEAN_AUDIT),
    });
    assert.equal(signals.hasPasswordHashing, true);
  });

  it('detects argon2 as password hashing', () => {
    const files = {
      [`${ROOT}/auth.js`]: `const argon2 = require('argon2');`,
    };
    const signals = collectSecuritySignals(ROOT, {
      fsImpl: makeFs(files, ROOT),
      execFileSync: makeExec(CLEAN_AUDIT),
    });
    assert.equal(signals.hasPasswordHashing, true);
  });

  it('detects crypto.scryptSync as password hashing', () => {
    const files = {
      [`${ROOT}/hash.js`]: `const hash = crypto.scryptSync(password, salt, 64);`,
    };
    const signals = collectSecuritySignals(ROOT, {
      fsImpl: makeFs(files, ROOT),
      execFileSync: makeExec(CLEAN_AUDIT),
    });
    assert.equal(signals.hasPasswordHashing, true);
  });

  it('detects httpOnly cookie flag as safe token storage', () => {
    const files = {
      [`${ROOT}/session.js`]: `res.cookie('token', value, { httpOnly: true, secure: true, sameSite: 'lax' });`,
    };
    const signals = collectSecuritySignals(ROOT, {
      fsImpl: makeFs(files, ROOT),
      execFileSync: makeExec(CLEAN_AUDIT),
    });
    assert.equal(signals.hasSafeTokenStorage, true);
  });

  it('returns false for safe token storage when localStorage.setItem is used', () => {
    const files = {
      [`${ROOT}/client.js`]: `
        res.cookie('x', v, { httpOnly: true });
        localStorage.setItem('authToken', token);
      `,
    };
    const signals = collectSecuritySignals(ROOT, {
      fsImpl: makeFs(files, ROOT),
      execFileSync: makeExec(CLEAN_AUDIT),
    });
    assert.equal(
      signals.hasSafeTokenStorage,
      false,
      'unsafe localStorage write overrides positive httpOnly signal',
    );
  });

  it('detects server-side authorization pattern', () => {
    const files = {
      [`${ROOT}/middleware/authz.js`]: `
        function requireOwner(req, res, next) {
          if (!isOwner(req.user, req.params.id)) return res.sendStatus(403);
          next();
        }
      `,
    };
    const signals = collectSecuritySignals(ROOT, {
      fsImpl: makeFs(files, ROOT),
      execFileSync: makeExec(CLEAN_AUDIT),
    });
    assert.equal(signals.hasServerSideAuthz, true);
  });

  it('detects authorize() call as server-side authorization', () => {
    const files = {
      [`${ROOT}/routes/project.js`]: `authorize(req.user, 'update', project);`,
    };
    const signals = collectSecuritySignals(ROOT, {
      fsImpl: makeFs(files, ROOT),
      execFileSync: makeExec(CLEAN_AUDIT),
    });
    assert.equal(signals.hasServerSideAuthz, true);
  });

  it('detects express-rate-limit as auth rate limiting', () => {
    const files = {
      [`${ROOT}/app.js`]: `import rateLimit from 'express-rate-limit';`,
    };
    const signals = collectSecuritySignals(ROOT, {
      fsImpl: makeFs(files, ROOT),
      execFileSync: makeExec(CLEAN_AUDIT),
    });
    assert.equal(signals.hasAuthRateLimiting, true);
  });

  it('detects rateLimit() call as auth rate limiting', () => {
    const files = {
      [`${ROOT}/auth.js`]: `app.use('/auth', rateLimit({ windowMs: 60000, max: 10 }));`,
    };
    const signals = collectSecuritySignals(ROOT, {
      fsImpl: makeFs(files, ROOT),
      execFileSync: makeExec(CLEAN_AUDIT),
    });
    assert.equal(signals.hasAuthRateLimiting, true);
  });
});

describe('collectSecuritySignals — multi-signal fixture', () => {
  it('returns all signals true for a workspace implementing all MUSTs', () => {
    const files = {
      [`${ROOT}/index.js`]: `
        import express from 'express';
        import rateLimit from 'express-rate-limit';
        import { z } from 'zod';
        const app = express();
        app.use('/auth', rateLimit({ windowMs: 60000, max: 10 }));
      `,
      [`${ROOT}/auth.js`]: `
        import bcrypt from 'bcrypt';
        const hash = await bcrypt.hash(password, 12);
        res.cookie('session', token, { httpOnly: true, secure: true, sameSite: 'strict' });
      `,
      [`${ROOT}/middleware/authz.js`]: `
        function requireOwner(req, res, next) {
          if (!isOwner(req.user, req.params.id)) return res.sendStatus(403);
          next();
        }
        module.exports = { requireOwner };
      `,
    };

    const auditJson = JSON.stringify({
      metadata: {
        vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 0 },
      },
    });

    const signals = collectSecuritySignals(ROOT, {
      fsImpl: makeFs(files, ROOT),
      execFileSync: makeExec(auditJson),
    });

    assert.equal(signals.hasEdgeInputValidation, true);
    assert.equal(signals.hasPasswordHashing, true);
    assert.equal(signals.hasSafeTokenStorage, true);
    assert.equal(signals.hasServerSideAuthz, true);
    assert.equal(signals.hasAuthRateLimiting, true);
    assert.equal(signals.depAuditVulnCount, 0);
    assert.equal(signals.secretScanCount, 0);
  });

  it('output is shaped for computeSecurity in dimensions.js', () => {
    // Verify the returned object carries exactly the fields computeSecurity
    // needs so the caller can forward them directly.
    const signals = collectSecuritySignals(ROOT, {
      fsImpl: makeFs(CLEAN_FILES, ROOT),
      execFileSync: makeExec(CLEAN_AUDIT),
    });

    const expectedKeys = [
      'secretScanCount',
      'depAuditVulnCount',
      'hasEdgeInputValidation',
      'hasPasswordHashing',
      'hasSafeTokenStorage',
      'hasServerSideAuthz',
      'hasAuthRateLimiting',
    ];

    for (const key of expectedKeys) {
      assert.ok(Object.hasOwn(signals, key), `missing key: ${key}`);
    }

    // No extra keys that could carry secret material
    const actualKeys = Object.keys(signals).sort();
    assert.deepEqual(actualKeys, [...expectedKeys].sort());
  });
});

describe('collectSecuritySignals — edge cases', () => {
  it('handles an empty workspace (no files) gracefully', () => {
    const signals = collectSecuritySignals(ROOT, {
      fsImpl: makeFs({}, ROOT),
      execFileSync: makeExec(CLEAN_AUDIT),
    });
    assert.equal(signals.secretScanCount, 0);
    assert.equal(signals.depAuditVulnCount, 0);
    assert.equal(signals.hasEdgeInputValidation, false);
    assert.equal(signals.hasPasswordHashing, false);
    assert.equal(signals.hasSafeTokenStorage, false);
    assert.equal(signals.hasServerSideAuthz, false);
    assert.equal(signals.hasAuthRateLimiting, false);
  });

  it('skips node_modules directory', () => {
    // Put a "secret" inside node_modules — the scanner must not enter it
    const files = {
      [`${ROOT}/node_modules/pkg/index.js`]: `const apiKey = 'sk-abcdefghijklmnopqrstuvwx';`,
      [`${ROOT}/app.js`]: `// no signals`,
    };
    const signals = collectSecuritySignals(ROOT, {
      fsImpl: makeFs(files, ROOT),
      execFileSync: makeExec(CLEAN_AUDIT),
    });
    assert.equal(signals.secretScanCount, 0, 'node_modules must be skipped');
  });

  it('skips files that cannot be read', () => {
    // readFileSync throws for one file — should continue scanning others
    const goodContent = `import { z } from 'zod';`;
    const badPath = `${ROOT}/bad.js`;
    const goodPath = `${ROOT}/good.js`;

    const fsImpl = {
      readdirSync(dir) {
        if (dir === ROOT) {
          return [
            { name: 'bad.js', isDirectory: () => false, isFile: () => true },
            { name: 'good.js', isDirectory: () => false, isFile: () => true },
          ];
        }
        return [];
      },
      readFileSync(p) {
        if (p === badPath) {
          const err = new Error('EACCES: permission denied');
          err.code = 'EACCES';
          throw err;
        }
        if (p === goodPath) return goodContent;
        throw new Error('unexpected path');
      },
    };

    const signals = collectSecuritySignals(ROOT, {
      fsImpl,
      execFileSync: makeExec(CLEAN_AUDIT),
    });
    // The good file should still be scanned
    assert.equal(signals.hasEdgeInputValidation, true);
  });
});
