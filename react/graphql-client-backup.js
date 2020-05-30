import React from 'react';

function _defineProperty(obj, key, value) {
  if (key in obj) {
    Object.defineProperty(obj, key, {
      value: value,
      enumerable: true,
      configurable: true,
      writable: true
    });
  } else {
    obj[key] = value;
  }

  return obj;
}

class Cache {
  constructor(cacheSize = DEFAULT_CACHE_SIZE) {
    _defineProperty(this, "_cache", new Map([]));

    this.cacheSize = cacheSize;
  }

  get keys() {
    return [...this._cache.keys()];
  }

  get entries() {
    return [...this._cache];
  }

  get(key) {
    return this._cache.get(key);
  }

  set(key, results) {
    this._cache.set(key, results);
  }

  removeItem(key) {
    this._cache.delete(key);
  }

  clearCache() {
    this._cache.clear();
  }

  setPendingResult(graphqlQuery, promise) {
    let cache = this._cache; //front of the line now, to support LRU ejection

    cache.delete(graphqlQuery);

    if (cache.size === this.cacheSize) {
      //maps iterate entries and keys in insertion order - zero'th key should be oldest
      cache.delete([...cache.keys()][0]);
    }

    cache.set(graphqlQuery, promise);
  }

  setResults(promise, cacheKey, resp, err) {
    let cache = this._cache; //cache may have been cleared while we were running. If so, we'll respect that, and not touch the cache, but
    //we'll still use the results locally

    if (cache.get(cacheKey) !== promise) return;

    if (err) {
      cache.set(cacheKey, {
        data: null,
        error: err
      });
    } else {
      if (resp.errors) {
        cache.set(cacheKey, {
          data: null,
          error: resp.errors
        });
      } else {
        cache.set(cacheKey, {
          data: resp.data,
          error: null
        });
      }
    }
  }

  getFromCache(key, ifPending, ifResults, ifNotFound = () => {}) {
    let cache = this._cache;
    let cachedEntry = cache.get(key);

    if (cachedEntry) {
      if (typeof cachedEntry.then === "function") {
        ifPending(cachedEntry);
      } else {
        //re-insert to put it at the fornt of the line
        cache.delete(key);
        this.set(key, cachedEntry);
        ifResults(cachedEntry);
      }
    } else {
      ifNotFound();
    }
  }

}
const DEFAULT_CACHE_SIZE = 10;

class Client {
  constructor(props = {
    cacheSize: DEFAULT_CACHE_SIZE
  }) {
    Object.assign(this, props);
    this.caches = new Map([]);
    this.mutationListeners = new Set([]);
    this.forceListeners = new Map([]);
  }

  get cacheSizeToUse() {
    return this.cacheSize > 0 ? this.cacheSize : DEFAULT_CACHE_SIZE;
  }

  preload(query, variables) {
    let cache = this.getCache(query);

    if (!cache) {
      cache = this.newCacheForQuery(query);
    }

    let graphqlQuery = this.getGraphqlQuery({
      query,
      variables
    });
    let promiseResult;
    cache.getFromCache(graphqlQuery, promise => {
      promiseResult = promise;
      /* already preloading - cool */
    }, cachedEntry => {
      /* already loaded - cool */
    }, () => {
      let promise = this.runUri(graphqlQuery);
      cache.setPendingResult(graphqlQuery, promise);
      promiseResult = promise;
      promise.then(resp => {
        cache.setResults(promise, graphqlQuery, resp);
      });
    });
    return promiseResult;
  }

  getCache(query) {
    return this.caches.get(query);
  }

  newCacheForQuery(query) {
    let newCache = new Cache(this.cacheSizeToUse);
    this.setCache(query, newCache);
    return newCache;
  }

  setCache(query, cache) {
    this.caches.set(query, cache);
  }

  runQuery(query, variables) {
    return this.runUri(this.getGraphqlQuery({
      query,
      variables
    }));
  }

  runUri(uri) {
    return fetch(uri, this.fetchOptions || void 0).then(resp => resp.json());
  }

  getGraphqlQuery({
    query,
    variables
  }) {
    return `${this.endpoint}?query=${encodeURIComponent(query)}${typeof variables === "object" ? `&variables=${encodeURIComponent(JSON.stringify(variables))}` : ""}`;
  }

  subscribeMutation(subscription, options = {}) {
    if (!Array.isArray(subscription)) {
      subscription = [subscription];
    }

    const packet = {
      subscription,
      options
    };

    if (!options.currentResults) {
      options.currentResults = () => ({});
    }

    this.mutationListeners.add(packet);
    return () => this.mutationListeners.delete(packet);
  }

  forceUpdate(query) {
    let updateListeners = this.forceListeners.get(query);

    if (updateListeners) {
      for (let refresh of updateListeners) {
        refresh();
      }
    }
  }

  registerQuery(query, refresh) {
    if (!this.forceListeners.has(query)) {
      this.forceListeners.set(query, new Set([]));
    }

    this.forceListeners.get(query).add(refresh);
    return () => this.forceListeners.get(query).delete(refresh);
  }

  processMutation(mutation, variables) {
    const refreshActiveQueries = query => this.forceUpdate(query);

    return Promise.resolve(this.runMutation(mutation, variables)).then(resp => {
      let mutationKeys = Object.keys(resp);
      let mutationKeysLookup = new Set(mutationKeys);
      [...this.mutationListeners].forEach(({
        subscription,
        options: {
          currentResults,
          isActive,
          ...rest
        }
      }) => {
        subscription.forEach(singleSubscription => {
          if (typeof isActive === "function") {
            if (!isActive()) {
              return;
            }
          }

          if (typeof singleSubscription.when === "string") {
            if (mutationKeysLookup.has(singleSubscription.when)) {
              singleSubscription.run({
                currentResults: currentResults(),
                refreshActiveQueries,
                ...rest
              }, resp, variables);
            }
          } else if (typeof singleSubscription.when === "object" && singleSubscription.when.test) {
            if ([...mutationKeysLookup].some(k => singleSubscription.when.test(k))) {
              singleSubscription.run({
                currentResults: currentResults(),
                refreshActiveQueries,
                ...rest
              }, resp, variables);
            }
          }
        });
      });
      return resp;
    });
  }

  runMutation(mutation, variables) {
    let {
      headers = {},
      ...otherOptions
    } = this.fetchOptions || {};
    return fetch(this.endpoint, {
      method: "post",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...headers
      },
      ...otherOptions,
      body: JSON.stringify({
        query: mutation,
        variables
      })
    }).then(resp => resp.json()).then(resp => resp.data);
  }

}

class DefaultClientManager {
  constructor() {
    _defineProperty(this, "defaultClient", null);

    _defineProperty(this, "setDefaultClient", client => this.defaultClient = client);

    _defineProperty(this, "getDefaultClient", () => this.defaultClient);
  }

}

const defaultClientManager = new DefaultClientManager();

function compress(strings, ...expressions) {
  return strings.map((string, i) => {
    const expression = i < expressions.length ? expressions[i] : "";
    return string.replace(/\s+/g, " ").replace(/ ,/g, ",").replace(/, /g, ",").replace(/ :/g, ":").replace(/: /g, ":").replace(/{ /g, "{").replace(/} /g, "}").replace(/ {/g, "{").replace(/ }/g, "}").replace(/ \(/g, "(").replace(/ \)/g, ")").replace(/\( /g, "(").replace(/\) /g, ")") + expression;
  }).join("").trim();
}

class QueryManager {
  constructor({
    client,
    refreshCurrent,
    cache,
    query,
    variables,
    options,
    isActive,
    suspense,
    preloadOnly
  }) {
    _defineProperty(this, "mutationSubscription", null);

    _defineProperty(this, "currentState", { ...QueryManager.initialState
    });

    _defineProperty(this, "updateState", newState => {
      if (this.query == 5){
        console.log("UPDATE STATE", newState);
      }
      this.suspendedPromise = null;
      Object.assign(this.currentState, newState);
      this.setState && this.setState(Object.assign({}, this.currentState));
    });

    _defineProperty(this, "refresh", () => {
      this.update();
    });

    _defineProperty(this, "softReset", newResults => {
      this.cache.clearCache();
      this.updateState({
        data: newResults
      });
    });

    _defineProperty(this, "hardReset", (startTransition = (fn) => { fn(); }) => {
      //this.cache.clearCache();
      
      //debugger
      startTransition(() => {
        this.cache.clearCache();
        this.reload();
      })
    });

    _defineProperty(this, "clearCacheAndReload", () => {
      let uri = this.currentState.currentQuery;

      if (uri) {
        this.cache.clearCache();
        this.update();
      }
    });

    _defineProperty(this, "reload", uriToUse => {
      let uri = this.currentState.currentQuery;

      if (uri) {
        this.cache.removeItem(uri);
        //debugger;
        this.refreshCurrent();
      }
    });

    _defineProperty(this, "handleExecution", (promise, cacheKey) => {
      return Promise.resolve(promise).then(resp => {
        this.cache.setResults(promise, cacheKey, resp);
        this.update();
      }).catch(err => {
        this.cache.setResults(promise, cacheKey, null, err);
        this.update();
      });
    });

    this.client = client || defaultClientManager.getDefaultClient();
    this.cache = cache || this.client.getCache(query) || this.client.newCacheForQuery(query);
    this.unregisterQuery = this.client.registerQuery(query, this.refresh);
    this.options = options;
    this.active = false;
    this.refreshCurrent = refreshCurrent;
    this.suspense = suspense;
    this.preloadOnly = preloadOnly;
    this.currentState.reload = this.reload;

    this.currentState.clearCache = () => this.cache.clearCache();

    this.currentState.clearCacheAndReload = this.clearCacheAndReload;
  }

  init() {
    let options = this.options;

    if (typeof options.onMutation === "object") {
      if (!Array.isArray(options.onMutation)) {
        options.onMutation = [options.onMutation];
      }

      this.mutationSubscription = this.client.subscribeMutation(options.onMutation, {
        cache: this.cache,
        softReset: this.softReset,
        hardReset: this.hardReset,
        refresh: this.refresh,
        currentResults: () => this.currentState.data,
        isActive: () => this.active
      });
    }
  }

  sync({
    query,
    variables,
    isActive
  }) {
    let wasInactive = !this.active;
    this.active = isActive;
    this.query = query;

    if (!this.active) {
      return;
    }

    let graphqlQuery = this.client.getGraphqlQuery({
      query,
      variables
    });
    this.currentUri = graphqlQuery;
    this.update();
  }

  update() {
    let suspense = this.suspense;
    let graphqlQuery = this.currentUri;
    this.cache.getFromCache(graphqlQuery, promise => {
      let updatingPromise = Promise.resolve(promise).then(() => {
        //cache should now be updated, unless it was cleared. Either way, re-run this method
        if (this.query == 5){
          console.log("IN PROGRESS")
        }
        this.update();
      });
      this.promisePending(updatingPromise);
    }, cachedEntry => {
      if (this.query == 5){
        console.log("QUERY DONE")
      }
      this.updateState({
        data: cachedEntry.data,
        error: cachedEntry.error || null,
        loading: false,
        loaded: true,
        currentQuery: graphqlQuery
      });
    }, () => {
      if (!(this.suspense && this.preloadOnly)) {
        if (this.query == 5){
          console.log("THROWING QUERY PROMISE")
        }
        let promise = this.execute(graphqlQuery);
        this.promisePending(promise);
      }
    });
  }

  promisePending(promise) {
    if (this.suspense) {
      this.suspendedPromise = promise;
      throw promise;
    } else {
      this.updateState({
        loading: true
      });
    }
  }

  execute(graphqlQuery) {
    let promise = this.client.runUri(graphqlQuery);
    this.cache.setPendingResult(graphqlQuery, promise);
    return this.handleExecution(promise, graphqlQuery);
  }

  dispose() {
    this.mutationSubscription && this.mutationSubscription();
    this.unregisterQuery();
  }

}

_defineProperty(QueryManager, "initialState", {
  loading: false,
  loaded: false,
  data: null,
  error: null
});

const {
  useState,
  useRef,
  useLayoutEffect
} = React;
function useQuery(query, variables, options = {}, {
  suspense
} = {}) {
  let currentActive = useRef(null);
  let currentQuery = useRef(null);
  let [deactivateQueryToken, setDeactivateQueryToken] = useState(0);

  let refreshCurrent = () => {
    currentQuery.current = "";
    setDeactivateQueryToken(x => x + 1);
  };

  let isActive = !("active" in options && !options.active);
  let [queryManager] = useState(() => new QueryManager({ ...options,
    refreshCurrent,
    query,
    variables,
    options,
    isActive,
    suspense,
    preloadOnly: options.preloadOnly
  }));
  let nextQuery = queryManager.client.getGraphqlQuery({
    query,
    variables
  });
  let [queryState, setQueryState] = useState(queryManager.currentState);
  queryManager.setState = setQueryState;

  if (currentActive.current != isActive || currentQuery.current != nextQuery) {
    if (query == 5){
      console.log("STARTING")
      // debugger;
    }
    currentActive.current = isActive;
    currentQuery.current = nextQuery;
    queryManager.sync({
      query,
      variables,
      isActive
    });
    if (query == 5){
      console.log("MAY NOT HAVE THROWN")
      // debugger;
    }
  } else if (queryManager.suspendedPromise) {
    if (query == 5){
      console.log("RE-THROW")
      // debugger;
    }
    throw queryManager.suspendedPromise;
  } else {
    if (query == 5){
      console.log("DONE")
      // debugger;
    }
  }

  useLayoutEffect(() => {
    queryManager.init();
    return () => queryManager.dispose();
  }, []);
  return queryManager.currentState;
}
const useSuspenseQuery = (query, variables, options = {}) => useQuery(query, variables, options, {
  suspense: true
});

class MutationManager {
  constructor({
    client,
    setState
  }, mutation, options) {
    _defineProperty(this, "runMutation", variables => {
      this.setState({
        running: true,
        finished: false,
        runMutation: this.runMutation
      });
      return this.client.processMutation(this.mutation, variables).then(resp => {
        this.setState({
          running: false,
          finished: true,
          runMutation: this.runMutation
        });
        return resp;
      });
    });

    _defineProperty(this, "currentState", { ...MutationManager.initialState,
      runMutation: this.runMutation
    });

    _defineProperty(this, "updateState", (newState = {}) => {
      Object.assign(this.currentState, newState);
      this.setState(this.currentState);
    });

    this.client = client;
    this.setState = setState;
    this.mutation = mutation;
  }

}

_defineProperty(MutationManager, "initialState", {
  running: false,
  finished: false
});

const {
  useState: useState$1,
  useRef: useRef$1,
  useMemo,
  useLayoutEffect: useLayoutEffect$1
} = React;
function useMutation(mutation, options = {}) {
  let [mutationState, setMutationState] = useState$1(null);
  let client = options.client || defaultClientManager.getDefaultClient();
  let mutationManagerRef = useRef$1(null);

  if (!mutationManagerRef.current) {
    mutationManagerRef.current = new MutationManager({
      client,
      setState: setMutationState
    }, mutation, options);
    mutationManagerRef.current.updateState();
  }

  useLayoutEffect$1(() => () => mutationManagerRef.current.setState = () => {}, []);
  return mutationState || mutationManagerRef.current.currentState;
}

const {
  setDefaultClient,
  getDefaultClient
} = defaultClientManager;

export { Cache, Client, compress, getDefaultClient, setDefaultClient, useMutation, useQuery, useSuspenseQuery };
