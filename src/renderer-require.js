import path from 'path';
import {AsyncSubject, Observable, Subject} from 'rx';
import {fromRemoteWindow} from './remote-event';

import {createProxyForRemote, executeJavaScriptMethod, executeJavaScriptMethodObservable, RecursiveProxyHandler} from './execute-js-func';

import './custom-operators';

const d = require('debug-electron')('electron-remote:renderer-require');

const isBrowser = process.type === 'browser';

const BrowserWindow = isBrowser ?
  require('electron').BrowserWindow:
  require('electron').remote.BrowserWindow;

/**
 * Creates a BrowserWindow, requires a module in it, then returns a Proxy
 * object that will call into it. You probably want to use {requireTaskPool}
 * instead.
 *
 * @param  {string} modulePath  The path of the module to include.
 * * @return {Object}             Returns an Object with a `module` which is a Proxy
 *                              object, and a `dispose` method that will clean up
 *                              the window.
 */
export async function rendererRequireDirect(modulePath) {
  let bw = new BrowserWindow({width: 500, height: 500, show: false});
  let fullPath = require.resolve(modulePath);

  let ready = isBrowser ?
    windowIsReady(bw) :
    remoteWindowIsReady(bw);

  /* Uncomment for debugging!
  bw.show();
  bw.openDevTools();
  */

  let preloadFile = path.join(__dirname, 'renderer-require-preload.html');
  bw.loadURL(`file:///${preloadFile}?module=${encodeURIComponent(fullPath)}`);
  await ready;

  let fail = await executeJavaScriptMethod(bw, 'window.moduleLoadFailure');
  if (fail) {
    let msg = await executeJavaScriptMethod(bw, 'window.moduleLoadFailure.message');
    throw new Error(msg);
  }

  return {
    module: createProxyForRemote(bw).requiredModule,
    executeJavaScriptMethod: (chain, ...args) => executeJavaScriptMethod(bw, chain, ...args),
    executeJavaScriptMethodObservable: (chain, ...args) => executeJavaScriptMethodObservable(bw, 240*1000, chain, ...args),
    dispose: () => bw.close()
  };
}

function windowIsReady(bw) {
  return new Promise((res,rej) => {
    bw.webContents.once('did-finish-load', () => res(true));
    bw.webContents.once('did-fail-load', (ev, errCode, errMsg) => rej(new Error(errMsg)));
  });
}

function remoteWindowIsReady(bw) {
  return Observable.merge(
    fromRemoteWindow(bw, 'did-finish-load', true),
    fromRemoteWindow(bw, 'did-fail-load', true)
      .flatMap(([, , errMsg]) => Observable.throw(new Error(errMsg)))
    ).take(1).toPromise();
}

/**
 * requires a module in BrowserWindows that are created/destroyed as-needed, and
 * returns a Proxy object that will secretly marshal invocations to other processes
 * and marshal back the result. This is the cool method in this library.
 *
 * Note that since the global context is created / destroyed, you *cannot* rely
 * on module state (i.e. global variables) to be consistent
 *
 * @param  {string} modulePath       The path to the module. You may have to
 *                                   `require.resolve` it.
 * @param  {Number} maxConcurrency   The maximum number of concurrent processes
 *                                   to run. Defaults to 4.
 *
 * @return {Proxy}                   An ES6 Proxy object representing the module.
 */
export function requireTaskPool(modulePath, maxConcurrency=4) {
  return new RendererTaskpoolItem(modulePath, maxConcurrency).moduleProxy;
}

/**
 * This class implements the scheduling logic for queuing and dispatching method
 * invocations to various background windows. It is complicated. But in like,
 * a cool way.
 */
class RendererTaskpoolItem {
  constructor(modulePath, maxConcurrency) {
    const freeWindowList = [];
    const invocationQueue = new Subject();
    const completionQueue = new Subject();

    // This method will find a window that is currently idle or if it doesn't
    // exist, create one.
    const getOrCreateWindow = () => {
      let item = freeWindowList.pop();
      if (item) return Observable.return(item);

      return Observable.fromPromise(rendererRequireDirect(modulePath));
    };

    // Here, we set up a pipeline that maps a stream of invocations (i.e.
    // something we can pass to executeJavaScriptMethod) => stream of Future
    // Results from various windows => Stream of completed results, for which we
    // throw the Window that completed the result back onto the free window stack.
    invocationQueue
      .map(({chain, args, retval}) => Observable.defer(() => {
        return getOrCreateWindow()
          .flatMap((wnd) => {
            d(`Actually invoking ${chain.join('.')}(${JSON.stringify(args)})`);
            let ret = wnd.executeJavaScriptMethodObservable(chain, ...args);

            ret.multicast(retval).connect();
            return ret.map(() => wnd).catch(Observable.return(wnd));
          });
      }))
      .merge(maxConcurrency)
      .subscribe((wnd) => {
        if (!wnd || !wnd.dispose) throw new Error("Bogus!");
        freeWindowList.push(wnd);
        completionQueue.onNext(true);
      });

    // Here, we create a version of RecursiveProxyHandler that will turn method
    // invocations into something we can push onto our invocationQueue pipeline.
    // This is the object that ends up being returned to the caller of
    // requireTaskPool.
    this.moduleProxy = RecursiveProxyHandler.create('__removeme__', (methodChain, args) => {
      let chain = methodChain.splice(1);

      d(`Queuing ${chain.join('.')}(${JSON.stringify(args)})`);
      let retval = new AsyncSubject();

      invocationQueue.onNext({ chain: ['requiredModule'].concat(chain), args, retval });
      return retval.toPromise();
    });

    // If we haven't received any invocations within a certain idle timeout
    // period, burn all of our BrowserWindow instances
    completionQueue.guaranteedThrottle(5*1000).subscribe(() => {
      d(`Freeing ${freeWindowList.length} taskpool processes`);
      while (freeWindowList.length > 0) {
        let wnd = freeWindowList.pop();
        if (wnd) wnd.dispose();
      }
    });
  }
}
