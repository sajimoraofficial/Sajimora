// Some sandboxed Windows process tokens make libuv's uv_os_get_passwd fail
// even though USERPROFILE, USERNAME, and the temporary directory are valid.
// tsx calls os.userInfo() during startup, before any test code is loaded.
const os = require('node:os');
const { syncBuiltinESMExports } = require('node:module');

const nativeUserInfo = os.userInfo;
os.userInfo = function userInfoWithSandboxFallback(options) {
  try {
    return nativeUserInfo(options);
  } catch (error) {
    if (!error || error.syscall !== 'uv_os_get_passwd') throw error;

    const encoding = options && options.encoding;
    if (encoding === 'buffer') {
      const value = process.env.USERNAME || 'sandbox-user';
      const home = process.env.USERPROFILE || os.homedir();
      return {
        uid: -1,
        gid: -1,
        username: Buffer.from(value),
        homedir: Buffer.from(home),
        shell: null
      };
    }

    return {
      uid: -1,
      gid: -1,
      username: process.env.USERNAME || 'sandbox-user',
      homedir: process.env.USERPROFILE || os.homedir(),
      shell: null
    };
  }
};

syncBuiltinESMExports();
