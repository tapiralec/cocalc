/*
CoCalc, Copyright (C) 2018, Sagemath Inc.

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

---

SYNCHRONIZED TABLE -- defined by an object query

    - Do a query against a PostgreSQL table using our object query description.
    - Synchronization with the backend database is done automatically.

   Methods:
      - constructor(query): query = the name of a table (or a more complicated object)

      - set(map):  Set the given keys of map to their values; one key must be
                   the primary key for the table.  NOTE: Computed primary keys will
                   get automatically filled in; these are keys in schema.coffee,
                   where the set query looks like this say:
                      (obj, db) -> db.sha1(obj.project_id, obj.path)
      - get():     Current value of the query, as an immutable.js Map from
                   the primary key to the records, which are also immutable.js Maps.
      - get(key):  The record with given key, as an immutable Map.
      - get(keys): Immutable Map from given keys to the corresponding records.
      - get_one(): Returns one record as an immutable Map (useful if there
                   is only one record)

      - close():   Frees up resources, stops syncing, don't use object further

   Events:
      - 'before-change': fired right before (and in the same event loop) actually
                  applying remote incoming changes
      - 'change', [array of string primary keys] : fired any time the value of the query result
                 changes, *including* if changed by calling set on this object.
                 Also, called with empty list on first connection if there happens
                 to be nothing in this table.   If the primary key is not a string it is
                 converted to a JSON string.
      - 'disconnected': fired when table is disconnected from the server for some reason
      - 'connected': fired when table has successfully connected and finished initializing
                     and is ready to use
      - 'saved', [array of saved objects]: fired after confirmed successful save of objects to backend

STATES:

A SyncTable is a finite state machine as follows:

                          -------------------<------------------
                         \|/                                   |
    [connecting] --> [connected]  -->  [disconnected]  --> [reconnecting]

Also, there is a final state called 'closed', that the SyncTable moves to when
it will not be used further; this frees up all connections and used memory.
The table can't be used after it is closed.   The only way to get to the
closed state is to explicitly call close() on the table; otherwise, the
table will keep attempting to connect and work, until it works.

    (anything)  --> [closed]



- connecting   -- connecting to the backend, and have never connected before.

- connected    -- successfully connected to the backend, initialized, and receiving updates.

- disconnected -- table was successfully initialized, but the network connection
                  died. Can still takes writes, but they will never try to save to
                  the backend.  Waiting to reconnect when user connects back to the backend.

- reconnecting -- client just reconnected to the backend, so this table is now trying
                  to get the full current state of the table and initialize a changefeed.

- closed       -- table is closed, and memory/connections used by the table is freed.


WORRY: what if the user does a set and connecting (or reconnecting) takes a long time, e.g., suspend
a laptop, then resume?  The changes may get saved... a month later.  For some things, e.g., logs,
this could be fine.  However, on reconnect, the first thing is that complete upstream state of
table is set on server version of table, so reconnecting user only sends its changes if upstream
hasn't changed anything in that same record.

*/

// if true, will log to the console a huge amount of info about every get/set
let DEBUG: boolean = true;

export function set_debug(x: boolean): void {
  DEBUG = x;
}

import { EventEmitter } from "events";
import * as immutable from "immutable";

import { throttle } from "underscore";

const misc = require("./misc");
const schema = require("./schema");

const { defaults, required } = misc;

function is_fatal(err): boolean {
  return (
    typeof err === "string" &&
    err.slice(0, 5) === "FATAL" &&
    err.indexOf("tracker") === -1
  );
}

/*
We represent synchronized tables by an immutable.js mapping from the primary
key to the object.  Since PostgresQL primary keys can be compound (more than
just strings), e.g., they can be arrays, so we convert complicated keys to their
JSON representation.  A binary object doesn't make sense here in pure javascript,
but these do:
      string, number, time, boolean, or array
Everything automatically converts fine to a string except array, which is the
main thing this function deals with below.
NOTE (1)  RIGHT NOW:  This should be safe to change at
any time, since the keys aren't stored longterm.
If we do something with localStorage, this will no longer be safe
without a version number.
NOTE (2) Of course you could use both a string and an array as primary keys
in the same table.  You could evily make the string equal the json of an array,
and this *would* break things.  We are thus assuming that such mixing
doesn't happen.  An alternative would be to just *always* use a *stable* version of stringify.
NOTE (3) we use a stable version, since otherwise things will randomly break if the
key is an object.
*/

const json_stable_stringify = require("json-stable-stringify");

import { Plug } from "./synctable-plug";

function to_key(x: string | object): string {
  if (typeof x === "object") {
    return json_stable_stringify(x);
  } else {
    return x;
  }
}

class SyncTable extends EventEmitter {
  private query: any;
  private options: any;
  private client: any;
  private debounce_interval: number;
  private throttle_changes?: number;

  // The value of this query locally.
  private value_local?: immutable.Map<string, any>;

  // Our best guess as to the value of this query on the server,
  // according to queries and updates the server pushes to us.
  private value_server?: immutable.Map<string, any>;

  // The changefeed id, when set by doing a change-feed aware query.
  private id?: string;

  // Not connected yet
  // disconnected <--> connected --> closed
  private state: string = "disconnected";

  private extra_debug: string;

  private plug: Plug;

  private table: string;

  private schema: any;

  constructor(
    query,
    options,
    client,
    debounce_interval,
    throttle_changes,
    cache_key
  ) {
    super();
    this.setMaxListeners(100);
    this.query = query;
    this.options = options;
    this.client = client;
    this.debounce_interval = debounce_interval;
    this.throttle_changes = throttle_changes;
    this.cache_key = cache_key;

    this.init_query();
    this.init_plug();
    this.init_disconnect();
    this.init_throttle_changes();;
  }

  private init_plug(): void {
    const extra_dbg = {};
    if (misc.is_object(this.query)) {
      for (let k in this.query) {
        const v = this.query[k];
        if (v !== null) {
          extra_dbg[k] = v;
        }
      }
    }
    this.plug = new Plug({
      name: this.table,
      client: this.client,
      connect: this.connect.bind(this),
      no_sign_in: this.schema.anonymous || this.client.is_project(),
      // note: projects don't have to authenticate
      extra_dbg // only for debugging
    });
  }

  private init_disconnect(): void {
    this.client.on("disconnected", () => {
      //console.log("synctable: DISCONNECTED")
      // When the connection is dropped, the backend hub notices that it was dropped
      // and immediately cancels all changefeeds.  Thus we set this.id to undefined
      // below, so that we don't redundantly cancel them again, which leads to an error
      // and wastes resources (which can pile up).
      this.id = undefined;
      return this.disconnected("client disconnect");
    });
  }

  private init_throttle_changes(): void {
    // No throttling of change events unless explicitly requested
    // *or* part of the schema.
    if (this.throttle_changes == null) {
      this.throttle_changes = __guard__(
        __guard__(
          schema.SCHEMA[this.table] != null
            ? schema.SCHEMA[this.table].user_query
            : undefined,
          x1 => x1.get
        ),
        x => x.throttle_changes
      );
    }

    if (!this.throttle_changes) {
      this.emit_change = changed_keys => this.emit("change", changed_keys);
    } else {
      // throttle emitting of change events
      let all_changed_keys = {};
      let do_emit_changes = () => {
        //console.log("#{@_table} -- emitting changes", misc.keys(all_changed_keys))
        // CRITICAL: some code depends on emitting change even for the *empty* list of keys!
        // E.g., projects page won't load for new users.  This is the *change* from not
        // loaded to being loaded, which does make sense.
        this.emit("change", misc.keys(all_changed_keys));
        return (all_changed_keys = {});
      };
      do_emit_changes = throttle(do_emit_changes, this.throttle_changes);
      this.emit_change = changed_keys => {
        //console.log("#{@_table} -- queue changes", changed_keys)
        for (let key of changed_keys) {
          all_changed_keys[key] = true;
        }
        return do_emit_changes();
      };
    }
  }

  private dbg(f) {
    //return @_client.dbg("SyncTable('#{@_table}').#{f}")
    return () => {};
  }

  private connect(cb) {
    const dbg = this.dbg("connect");
    dbg();
    if (this.state === "closed") {
      if (typeof cb === "function") {
        cb("closed");
      }
      return;
    }
    if (this.state === "connected") {
      if (typeof cb === "function") {
        cb();
      }
      return;
    }
    if (this.id != null) {
      this._client.query_cancel({ id: this.id });
      this.id = undefined;
    }

    return async.series(
      [
        cb => {
          // 1. save, in case we have any local unsaved changes, then sync with upstream.
          if (this.value_local != null && this.value_server != null) {
            return this._save(cb);
          } else {
            return cb();
          }
        },
        cb => {
          // 2. Now actually do the changefeed query.
          return this._reconnect(cb);
        }
      ],
      err => {
        return typeof cb === "function" ? cb(err) : undefined;
      }
    );
  }

  _reconnect(cb) {
    const dbg = this.dbg("_reconnect");
    if (this.state === "closed") {
      dbg("closed so don't do anything ever again");
      if (typeof cb === "function") {
        cb();
      }
      return;
    }
    // console.log("synctable", @_table, @_schema.db_standby)
    if (this.schema.db_standby && !this._client.is_project()) {
      return this._do_the_query_using_db_standby(cb);
    } else {
      return this._do_the_query(cb);
    }
  }

  _do_the_query(cb) {
    const dbg = this.dbg("_do_the_query");
    let first_resp = true;
    let this_query_id = undefined;
    dbg("do the query");
    return this.client.query({
      query: this.query,
      changes: true,
      timeout: 30,
      options: this.options,
      cb: (err, resp) => {
        if (this.state === "closed") {
          // already closed so ignore anything else.
          return;
        }

        if (is_fatal(err)) {
          console.warn("setting up changefeed", this.table, err, this.query);
          this.close(true);
          if (typeof cb === "function") {
            cb(err);
          }
          cb = undefined;
          return;
        }

        if (first_resp) {
          dbg("query got ", err, resp);
          first_resp = false;
          if (this.state === "closed") {
            return typeof cb === "function" ? cb("closed") : undefined;
          } else if (
            (resp != null ? resp.event : undefined) === "query_cancel"
          ) {
            return typeof cb === "function" ? cb("query-cancel") : undefined;
          } else if (err) {
            return typeof cb === "function" ? cb(err) : undefined;
          } else if (
            __guard__(
              resp != null ? resp.query : undefined,
              x => x[this.table]
            ) == null
          ) {
            return typeof cb === "function" ? cb("got no data") : undefined;
          } else {
            // Successfully completed query
            this_query_id = this.id = resp.id;
            this.state = "connected";
            this._update_all(resp.query[this.table]);
            this.emit("connected", resp.query[this.table]); // ready to use!
            if (typeof cb === "function") {
              cb();
            }
            // Do any pending saves
            for (cb of this._connected_save_cbs != null
              ? this._connected_save_cbs
              : []) {
              this.save(cb);
            }
            return delete this._connected_save_cbs;
          }
        } else {
          if (this.state !== "connected") {
            dbg("nothing to do -- ignore these, and make sure they stop");
            if (this_query_id != null) {
              this._client.query_cancel({ id: this_query_id });
            }
            return;
          }
          if (
            err ||
            (resp != null ? resp.event : undefined) === "query_cancel"
          ) {
            return this.disconnected(
              `err=${err}, resp?.event=${resp != null ? resp.event : undefined}`
            );
          } else {
            // Handle the update
            return this._update_change(resp);
          }
        }
      }
    });
  }

  _do_the_query_using_db_standby(cb) {
    let f;
    const dbg = this.dbg("_do_the_query_using_db_standby");
    if (this.schema.db_standby === "unsafe") {
      // do not even require the changefeed to be
      // working before doing the full query.  This would
      // for sure miss all changes from when the query
      // finishes until the changefeed starts.  For some
      // tables this is fine; for others, not.
      f = async.parallel;
    } else {
      // This still could miss a small amount of data, but only
      // for a tiny window.
      f = async.series;
    }

    /*
        * Use this for simulating async/slow loading behavior for a specific table.
        if @_table == 'accounts'
            console.log("delaying")
            await require('awaiting').delay(5000)
        */

    return f([this._start_changefeed, this._do_initial_read_query], err => {
      if (err) {
        dbg("FAIL", err);
        if (typeof cb === "function") {
          cb(err);
        }
        return;
      }
      dbg("Success");
      if (typeof cb === "function") {
        cb();
      }
      // Do any pending saves
      for (let c of this._connected_save_cbs != null
        ? this._connected_save_cbs
        : []) {
        this.save(c);
      }
      return delete this._connected_save_cbs;
    });
  }

  _do_initial_read_query(cb) {
    const dbg = this.dbg("_do_initial_read_query");
    dbg();
    return this.client.query({
      query: this.query,
      standby: true,
      timeout: 30,
      options: this.options,
      cb: (err, resp) => {
        if (err) {
          dbg("FAIL", err);
          return typeof cb === "function" ? cb(err) : undefined;
        } else {
          dbg("success!");
          this._update_all(resp.query[this.table]);
          this.state = "connected";
          this.emit("connected", resp.query[this.table]); // ready to use!
          return typeof cb === "function" ? cb() : undefined;
        }
      }
    });
  }

  _start_changefeed(cb) {
    const dbg = this.dbg("start_changefeed");
    let first_resp = true;
    let this_query_id = undefined;
    dbg("do the query");
    return this.client.query({
      query: this.query,
      changes: true,
      timeout: 30,
      options: (this.options != null ? this.options : []).concat({
        only_changes: true
      }),
      cb: (err, resp) => {
        if (this.state === "closed") {
          // already closed so ignore anything else.
          return;
        }

        if (is_fatal(err)) {
          console.warn("setting up changefeed", this.table, err, this.query);
          this.close(true);
          if (typeof cb === "function") {
            cb(err);
          }
          cb = undefined;
          return;
        }

        if (first_resp) {
          dbg("query got first resp", err, resp);
          first_resp = false;
          if (this.state === "closed") {
            return typeof cb === "function" ? cb("closed") : undefined;
          } else if (
            (resp != null ? resp.event : undefined) === "query_cancel"
          ) {
            return typeof cb === "function" ? cb("query-cancel") : undefined;
          } else if (err) {
            return typeof cb === "function" ? cb(err) : undefined;
          } else {
            // Successfully completed query to start changefeed.
            this_query_id = this.id = resp.id;
            return typeof cb === "function" ? cb() : undefined;
          }
        } else {
          if (this.state !== "connected") {
            // TODO: save them up and apply...?
            dbg("nothing to do -- ignore these, and make sure they stop");
            if (this_query_id != null) {
              this._client.query_cancel({ id: this_query_id });
            }
            return;
          }
          if (
            err ||
            (resp != null ? resp.event : undefined) === "query_cancel"
          ) {
            return this.disconnected(
              `err=${err}, resp?.event=${resp != null ? resp.event : undefined}`
            );
          } else {
            // Handle the update
            return this._update_change(resp);
          }
        }
      }
    });
  }

  private disconnected(why) {
    const dbg = this.dbg("_disconnected");
    dbg(`why=${why}`);
    if (this.state === "disconnected") {
      dbg("already disconnected");
      return;
    }
    if (this.id) {
      this._client.query_cancel({ id: this.id });
    }
    this.state = "disconnected";
    return this._plug.connect(); // start trying to connect again
  }

  // disconnect, then connect again.
  reconnect() {
    return this.disconnected("reconnect called");
  }

  // Return string key used in the immutable map in which this table is stored.
  key(obj) {
    return this._key(obj);
  }

  // Return true if there are changes to this synctable that
  // have NOT been confirmed as saved to the backend database.
  // Returns undefined if not initialized.
  has_uncommitted_changes() {
    if (this._value_server == null && this._value_local == null) {
      return;
    }
    if (this._value_local != null && this._value_server == null) {
      return true;
    }
    return !this._value_server.equals(this._value_local);
  }

  get(arg) {
    if (this._value_local == null) {
      return;
    }
    if (arg != null) {
      if (misc.is_array(arg)) {
        const x = {};
        for (let k of arg) {
          x[to_key(k)] = this._value_local.get(to_key(k));
        }
        return immutable.fromJS(x);
      } else {
        return this._value_local.get(to_key(arg));
      }
    } else {
      return this._value_local;
    }
  }

  get_one() {
    return this._value_local != null
      ? this._value_local.toSeq().first()
      : undefined;
  }

  private parse_query(query) {
    if (typeof query === "string") {
      // name of a table -- get all fields
      const v = misc.copy(schema.SCHEMA[query].user_query.get.fields);
      for (let k in v) {
        const _ = v[k];
        v[k] = null;
      }
      return { [query]: [v] };
    } else {
      const keys = misc.keys(query);
      if (keys.length !== 1) {
        throw Error("must specify exactly one table");
      }
      const table = keys[0];
      const x = {};
      if (!misc.is_array(query[table])) {
        return { [table]: [query[table]] };
      } else {
        return { [table]: query[table] };
      }
    }
  }

  private init_query() {
    // first parse the query to allow for some convenient shortcuts
    let pk;
    this.query = this.parse_query(this.query);

    // Check that the query is probably valid, and record the table and schema
    if (misc.is_array(this.query)) {
      throw Error("must be a single query");
    }
    const tables = misc.keys(this.query);
    if (misc.len(tables) !== 1) {
      throw Error("must query only a single table");
    }
    this.table = tables[0];
    if (this.client.is_project()) {
      this._client_query = schema.SCHEMA[this.table].project_query;
    } else {
      this._client_query = schema.SCHEMA[this.table].user_query;
    }
    if (!misc.is_array(this.query[this.table])) {
      throw Error("must be a multi-document queries");
    }
    this.schema = schema.SCHEMA[this.table];
    if (this.schema == null) {
      throw Error(`unknown schema for table ${this.table}`);
    }
    this._primary_keys = schema.client_db.primary_keys(this.table);
    // TODO: could put in more checks on validity of query here, using schema...
    for (let primary_key of this._primary_keys) {
      if (this.query[this.table][0][primary_key] == null) {
        // must include each primary key in query
        this.query[this.table][0][primary_key] = null;
      }
    }
    // Function @_to_key to extract primary key from object
    if (this._primary_keys.length === 1) {
      // very common case
      pk = this._primary_keys[0];
      this._key = obj => {
        if (obj == null) {
          return;
        }
        if (immutable.Map.isMap(obj)) {
          return to_key(obj.get(pk));
        } else {
          return to_key(obj[pk]);
        }
      };
    } else {
      // compound primary key
      this._key = obj => {
        let a;
        if (obj == null) {
          return;
        }
        const v = [];
        if (immutable.Map.isMap(obj)) {
          for (pk of this._primary_keys) {
            a = obj.get(pk);
            if (a == null) {
              return;
            }
            v.push(a);
          }
        } else {
          for (pk of this._primary_keys) {
            a = obj[pk];
            if (a == null) {
              return;
            }
            v.push(a);
          }
        }
        return to_key(v);
      };
    }

    // Which fields the user is allowed to set.
    this._set_fields = [];
    // Which fields *must* be included in any set query
    this._required_set_fields = {};
    for (var field of misc.keys(this.query[this.table][0])) {
      if (
        __guard__(
          __guard__(
            this._client_query != null ? this._client_query.set : undefined,
            x1 => x1.fields
          ),
          x => x[field]
        ) != null
      ) {
        this._set_fields.push(field);
      }
      if (
        __guard__(
          __guard__(
            this._client_query != null ? this._client_query.set : undefined,
            x3 => x3.required_fields
          ),
          x2 => x2[field]
        ) != null
      ) {
        this._required_set_fields[field] = true;
      }
    }

    // Is anonymous access to this table allowed?
    return (this._anonymous = !!this.schema.anonymous);
  }

  // Return map from keys that have changed along with how they changed, or undefined
  // if the value of local or the server hasn't been initialized
  _changes() {
    if (this._value_server == null || this._value_local == null) {
      return;
    }
    const changed = {};
    this._value_local.map((new_val, key) => {
      const old_val = this._value_server.get(key);
      if (!new_val.equals(old_val)) {
        return (changed[key] = { new_val, old_val });
      }
    });
    return changed;
  }

  _save(cb) {
    if (this.state === "closed") {
      if (typeof cb === "function") {
        cb("closed");
      }
      return;
    }
    if (this.__is_saving) {
      return typeof cb === "function" ? cb("already saving") : undefined;
    } else {
      this.__is_saving = true;
      return this.__save(err => {
        this.__is_saving = false;
        return typeof cb === "function" ? cb(err) : undefined;
      });
    }
  }

  __save(cb) {
    let k, v;
    if (this.state === "closed") {
      if (typeof cb === "function") {
        cb("closed");
      }
      return;
    }
    // console.log("_save('#{@_table}')")
    // Determine which records have changed and what their new values are.
    if (this.value_server == null) {
      if (typeof cb === "function") {
        cb("don't know server yet");
      }
      return;
    }
    if (this.value_local == null) {
      if (typeof cb === "function") {
        cb("don't know local yet");
      }
      return;
    }

    if (this._client_query.set == null) {
      // Nothing to do -- can never set anything for this table.
      // There are some tables (e.g., stats) where the remote values
      // could change while user is offline, and the code below would
      // result in warnings.
      if (typeof cb === "function") {
        cb();
      }
      return;
    }

    const changed = this._changes();
    const at_start = this.value_local;

    // Send our changes to the server.
    const query = [];
    const saved_objs = [];
    // sort so that behavior is more predictable = faster (e.g., sync patches are in
    // order); the keys are strings so default sort is fine
    for (let key of misc.keys(changed).sort()) {
      const c = changed[key];
      const obj = {};
      // NOTE: this may get replaced below with proper javascript, e.g., for compound primary key
      if (this._primary_keys.length === 1) {
        obj[this._primary_keys[0]] = key;
      } else {
        // unwrap compound primary key
        v = JSON.parse(key);
        let i = 0;
        for (let primary_key of this._primary_keys) {
          obj[primary_key] = v[i];
          i += 1;
        }
      }

      for (k of this._set_fields) {
        v = c.new_val.get(k);
        if (v != null) {
          if (
            this._required_set_fields[k] ||
            !immutable.is(v, c.old_val != null ? c.old_val.get(k) : undefined)
          ) {
            if (immutable.Iterable.isIterable(v)) {
              obj[k] = v.toJS();
            } else {
              obj[k] = v;
            }
          }
        }
      }
      query.push({ [this.table]: obj });
      saved_objs.push(obj);
    }

    // console.log("sending #{query.length} changes: #{misc.to_json(query)}")
    if (query.length === 0) {
      if (typeof cb === "function") {
        cb();
      }
      return;
    }
    //console.log("query=#{misc.to_json(query)}")
    //Use this to test fix_if_no_update_soon:
    //    if Math.random() <= .5
    //        query = []
    //@_fix_if_no_update_soon() # -disabled -- instead use "checking changefeed ids".
    return this._client.query({
      query,
      options: [{ set: true }], // force it to be a set query
      timeout: 30,
      cb: err => {
        if (err) {
          if (is_fatal(err)) {
            console.warn("FATAL doing set", this.table, err);
            this.close(true);
            if (typeof cb === "function") {
              cb(err);
            }
            cb = undefined;
            return;
          }

          console.warn(`_save('${this.table}') error:`, err);
          if (err === "clock") {
            this._client.alert_message({
              type: "error",
              timeout: 9999,
              message:
                "Your computer's clock is or was off!  Fix it and **refresh your browser**."
            });
          }
          return typeof cb === "function" ? cb(err) : undefined;
        } else {
          if (this.state === "closed") {
            // this can happen in case synctable is closed after _save is called but before returning from this query.
            if (typeof cb === "function") {
              cb("closed");
            }
            return;
          }
          if (this.value_server == null || this.value_local == null) {
            // There is absolutely no possible way this can happen, since it was
            // checked for above before the call, and these can only get set by
            // the close method to undefined, which also sets the @_state to closed,
            // so would get caught above.  However, evidently this **does happen**:
            //   https://github.com/sagemathinc/cocalc/issues/1870
            if (typeof cb === "function") {
              cb("value_server and value_local must be set");
            }
            return;
          }
          this.emit("saved", saved_objs);
          // success: each change in the query what committed successfully to the database; we can
          // safely set @_value_server (for each value) as long as it didn't change in the meantime.
          for (k in changed) {
            v = changed[k];
            if (immutable.is(this.value_server.get(k), v.old_val)) {
              // immutable.is since either could be undefined
              //console.log "setting @_value_server[#{k}] =", v.new_val?.toJS()
              this.value_server = this.value_server.set(k, v.new_val);
            }
          }
          if (!at_start.equals(this.value_local)) {
            // keep saving until @_value_local doesn't change *during* the save -- this means
            // when saving stops that we guarantee there are no unsaved changes.
            return this._save(cb);
          } else {
            return typeof cb === "function" ? cb() : undefined;
          }
        }
      }
    });
  }

  save(cb) {
    if (this.state === "closed") {
      if (typeof cb === "function") {
        cb("closed");
      }
      return;
    }
    if (this.state !== "connected") {
      if (typeof cb === "function") {
        cb("not connected");
      } // do not change this error message; it is assumed elsewhere.
      return;
    }

    if (this._save_debounce == null) {
      this._save_debounce = {};
    }

    if (this.value_server == null || this.value_local == null) {
      if (this._connected_save_cbs == null) {
        this._connected_save_cbs = [];
      }
      this._connected_save_cbs.push(cb);
      return;
    }

    return misc.async_debounce({
      f: cb => {
        return misc.retry_until_success({
          f: this._save,
          max_delay: 20000,
          max_time: 60000,
          cb
        });
      },
      interval: this._debounce_interval,
      state: this._save_debounce,
      cb
    });
  }

  // Handle an update of all records from the database.  This happens on
  // initialization, and also if we disconnect and reconnect.
  _update_all(v) {
    let changed_keys, first_connect;
    const dbg = this.dbg("_update_all");

    if (this.state === "closed") {
      // nothing to do -- just ignore updates from db
      return;
    }

    if (v == null) {
      console.warn(`_update_all('${this.table}') called with v=undefined`);
      return;
    }

    this.emit("before-change");
    // Restructure the array of records in v as a mapping from the primary key
    // to the corresponding record.
    const x = {};
    for (let y of v) {
      x[this._key(y)] = y;
    }

    let conflict = false;

    // Figure out what to change in our local view of the database query result.
    if (this.value_local == null || this.value_server == null) {
      dbg(
        "easy case -- nothing has been initialized yet, so just set everything."
      );
      this.value_local = this.value_server = immutable.fromJS(x);
      first_connect = true;
      changed_keys = misc.keys(x); // of course all keys have been changed.
    } else {
      dbg("harder case -- everything has already been initialized.");
      changed_keys = [];

      // DELETE or CHANGED:
      // First check through each key in our local view of the query
      // and if the value differs from what is in the database (i.e.,
      // what we just got from DB), make that change.
      // (Later we will possibly merge in the change
      // using the last known upstream database state.)
      this.value_local.map((local, key) => {
        if (x[key] != null) {
          // update value we have locally
          if (this._handle_new_val(x[key], changed_keys)) {
            return (conflict = true);
          }
        } else {
          // This is a value defined locally that does not exist
          // on the remote serve.   It could be that the value
          // was deleted when we weren't connected, in which case
          // we should delete the value we have locally.  On the
          // other hand, maybe the local value was newly set
          // while we weren't connected, so we know it but the
          // backend server doesn't, which case we should keep it,
          // and set conflict=true, so it gets saved to the backend.

          if (this.value_local.get(key).equals(this.value_server.get(key))) {
            // The local value for this key was saved to the backend before
            // we got disconnected, so there's definitely no need to try
            // keep it around, given that the backend no longer has it
            // as part of the query.  CRITICAL: This doesn't necessarily mean
            // the value was deleted from the database, but instead that
            // it doesn't satisfy the synctable query, e.g., it isn't one
            // of the 150 most recent file_use notifications, or it isn't
            // a patch that is at least as new as the newest snapshot.
            //console.log("removing local value: #{key}")
            this.value_local = this.value_local.delete(key);
            return changed_keys.push(key);
          } else {
            return (conflict = true);
          }
        }
      });

      // NEWLY ADDED:
      // Next check through each key in what's on the remote database,
      // and if the corresponding local key isn't defined, set its value.
      // Here we are simply checking for newly added records.
      for (let key in x) {
        const val = x[key];
        if (this.value_local.get(key) == null) {
          this.value_local = this.value_local.set(key, immutable.fromJS(val));
          changed_keys.push(key);
        }
      }
    }

    // It's possibly that nothing changed (e.g., typical case on reconnect!) so we check.
    // If something really did change, we set the server state to what we just got, and
    // also inform listeners of which records changed (by giving keys).
    //console.log("update_all: changed_keys=", changed_keys)
    if (changed_keys.length !== 0) {
      this.value_server = immutable.fromJS(x);
      this.emit_change(changed_keys);
    } else if (first_connect) {
      // First connection and table is empty.
      this.emit_change(changed_keys);
    }
    if (conflict) {
      return this.save();
    }
  }

  // Apply one incoming change from the database to the in-memory
  // local synchronized table
  _update_change(change) {
    //console.log("_update_change", change)
    if (this.state === "closed") {
      // We might get a few more updates even after
      // canceling the changefeed, so we just ignore them.
      return;
    }
    if (this.value_local == null) {
      console.warn(
        `_update_change(${
          this.table
        }): tried to call _update_change even though local not yet defined (ignoring)`
      );
      return;
    }
    if (this.value_server == null) {
      console.warn(
        `_update_change(${
          this.table
        }): tried to call _update_change even though set not yet defined (ignoring)`
      );
      return;
    }
    if (DEBUG) {
      console.log(`_update_change('${this.table}'): ${misc.to_json(change)}`);
    }
    this.emit("before-change");
    const changed_keys = [];
    let conflict = false;
    if (change.new_val != null) {
      conflict = this._handle_new_val(change.new_val, changed_keys);
    }

    if (
      change.old_val != null &&
      this._key(change.old_val) !== this._key(change.new_val)
    ) {
      // Delete a record (TODO: untested)
      const key = this._key(change.old_val);
      this.value_local = this.value_local.delete(key);
      this.value_server = this.value_server.delete(key);
      changed_keys.push(key);
    }

    //console.log("update_change: changed_keys=", changed_keys)
    if (changed_keys.length > 0) {
      //console.log("_update_change: change")
      this.emit_change(changed_keys);
      if (conflict) {
        return this.save();
      }
    }
  }

  _handle_new_val(val, changed_keys) {
    const key = this._key(val);
    const new_val = immutable.fromJS(val);
    let local_val = this.value_local.get(key);
    let conflict = false;
    if (!new_val.equals(local_val)) {
      //console.log("change table='#{@_table}': #{misc.to_json(local_val?.toJS())} --> #{misc.to_json(new_val.toJS())}") if @_table == 'patches'
      if (local_val == null) {
        this.value_local = this.value_local.set(key, new_val);
        changed_keys.push(key);
      } else {
        const server = this.value_server.get(key);
        // Set in @_value_local every key whose value changed between new_val and server; basically, we're
        // determining and applying the "patch" from upstream, even though it was sent as a complete record.
        // We can compute the patch, since we know the last server value.
        new_val.map((v, k) => {
          if (!immutable.is(v, server != null ? server.get(k) : undefined)) {
            return (local_val = local_val.set(k, v));
          }
        });
        //console.log("#{@_table}: set #{k} to #{v}")
        if (server != null) {
          server.map((v, k) => {
            if (!new_val.has(k)) {
              return (local_val = local_val.delete(k));
            }
          });
        }
        if (!local_val.equals(this.value_local.get(key))) {
          this.value_local = this.value_local.set(key, local_val);
          changed_keys.push(key);
        }
        if (!local_val.equals(new_val)) {
          //console.log("#{@_table}: conflict! ", local_val, new_val) if @_table == 'patches'
          this.emit("conflict", { new_val, old_val: local_val });
          conflict = true;
        }
      }
    }
    this.value_server = this.value_server.set(key, new_val);
    return conflict;
  }

  // obj is an immutable.js Map without the primary key
  // set.  If the database schema defines a way to compute
  // the primary key from other keys, try to use it here.
  // This function returns the computed primary key if it works,
  // and returns undefined otherwise.
  _computed_primary_key(obj) {
    let f;
    if (this._primary_keys.length === 1) {
      f = this._client_query.set.fields[this._primary_keys[0]];
      if (typeof f === "function") {
        return f(obj.toJS(), schema.client_db);
      } else {
        return;
      }
    } else {
      const v = [];
      for (let pk of this._primary_keys) {
        f = this._client_query.set.fields[pk];
        if (typeof f === "function") {
          v.push(f(obj.toJS(), schema.client_db));
        } else {
          return;
        }
      }
      return v;
    }
  }

  // Changes (or creates) one entry in the table.
  // The input field changes is either an Immutable.js Map or a JS Object map.
  // If changes does not have the primary key then a random record is updated,
  // and there *must* be at least one record.  Exception: computed primary
  // keys will be computed (see stuff about computed primary keys above).
  // The second parameter 'merge' can be one of three values:
  //   'deep'   : (DEFAULT) deep merges the changes into the record, keep as much info as possible.
  //   'shallow': shallow merges, replacing keys by corresponding values
  //   'none'   : do no merging at all -- just replace record completely
  // The cb is called with cb(err) if something goes wrong.
  // Returns the updated value.
  set(changes, merge, cb) {
    let new_val;
    if (this.state === "closed") {
      // Attempting to set on a closed table is dangerous since any data set *will* be
      // silently lost.  So spit out a visible warning.
      console.warn(
        `WARNING: attempt to do a set on a closed table: '${
          this.table
        }', ${misc.to_json(this.query)}`
      );
      if (typeof cb === "function") {
        cb("closed");
      }
      return;
    }

    if (!immutable.Map.isMap(changes)) {
      changes = immutable.fromJS(changes);
    }
    if (this.value_local == null) {
      this.value_local = immutable.Map({});
    }

    if (merge == null) {
      merge = "deep";
    } else if (typeof merge === "function") {
      cb = merge;
      merge = "deep";
    }

    if (!immutable.Map.isMap(changes)) {
      if (typeof cb === "function") {
        cb("type error -- changes must be an immutable.js Map or JS map");
      }
      return;
    }

    if (DEBUG) {
      console.log(`set('${this.table}'): ${misc.to_json(changes.toJS())}`);
    }

    // Ensure that each key is allowed to be set.
    if (this.client_query.set == null) {
      if (typeof cb === "function") {
        cb(`users may not set ${this.table}`);
      }
      return;
    }
    const can_set = this.client_query.set.fields;
    try {
      changes.map((v, k) => {
        if (can_set[k] === undefined) {
          throw Error(`users may not set ${this.table}.${k}`);
        }
      });
    } catch (e) {
      if (typeof cb === "function") {
        cb(e);
      }
      return;
    }

    // Determine the primary key's value
    let id = this._key(changes);
    if (id == null) {
      // attempt to compute primary key if it is a computed primary key
      let id0 = this._computed_primary_key(changes);
      id = to_key(id0);
      if (id == null && this._primary_keys.length === 1) {
        // use a "random" primary key from existing data
        id0 = id = this.value_local.keySeq().first();
      }
      if (id == null) {
        if (typeof cb === "function") {
          cb(
            `must specify primary key ${this._primary_keys.join(
              ","
            )}, have at least one record, or have a computed primary key`
          );
        }
        return;
      }
      // Now id is defined
      if (this._primary_keys.length === 1) {
        changes = changes.set(this._primary_keys[0], id0);
      } else {
        let i = 0;
        for (let pk of this._primary_keys) {
          changes = changes.set(pk, id0[i]);
          i += 1;
        }
      }
    }

    // Get the current value
    const cur = this.value_local.get(id);
    if (cur == null) {
      // No record with the given primary key.  Require that all the @_required_set_fields
      // are specified, or it will become impossible to sync this table to the backend.
      for (let k in this._required_set_fields) {
        const _ = this._required_set_fields[k];
        if (changes.get(k) == null) {
          if (typeof cb === "function") {
            cb(`must specify field '${k}' for new records`);
          }
          return;
        }
      }
      // If no current value, then next value is easy -- it equals the current value in all cases.
      new_val = changes;
    } else {
      // Use the appropriate merge strategy to get the next val.  Fortunately these are all built
      // into immutable.js!
      switch (merge) {
        case "deep":
          new_val = cur.mergeDeep(changes);
          break;
        case "shallow":
          new_val = cur.merge(changes);
          break;
        case "none":
          new_val = changes;
          break;
        default:
          if (typeof cb === "function") {
            cb("merge must be one of 'deep', 'shallow', 'none'");
          }
          return;
      }
    }
    // If something changed, then change in our local store, and also kick off a save to the backend.
    if (!immutable.is(new_val, cur)) {
      this.value_local = this.value_local.set(id, new_val);
      this.save(cb);
      this.emit_change([id]); // CRITICAL: other code assumes the key is *NOT* sent with this change event!
    } else {
      if (typeof cb === "function") {
        cb();
      }
    }

    return new_val;
  }

  close(fatal) {
    if (this.state === "closed") {
      // already closed
      return;
    }
    // decrement the reference to this synctable
    if (global_cache_decref(this)) {
      // close: not zero -- so don't close it yet -- still in use by multiple clients
      return;
    }
    this._plug.close();
    this.client.removeListener("disconnected", this.disconnected);
    if (!fatal) {
      // do a last attempt at a save (so we don't lose data), then really close.
      this._save(); // this will synchronously construct the last save and send it
    }
    // The moment the sync part of @_save is done, we remove listeners and clear
    // everything up.  It's critical that as soon as @close is called that there
    // be no possible way any further connect events (etc) can make this SyncTable
    // do anything!!  That finality assumption is made elsewhere (e.g in smc-project/client.coffee)
    this.removeAllListeners();
    if (this.id != null) {
      this._client.query_cancel({ id: this.id });
      delete this.id;
    }
    this.state = "closed";
    delete this.value_local;
    return delete this.value_server;
  }

  // wait until some function of this synctable is truthy
  // (this might be exactly the same code as in the postgres-synctable.coffee SyncTable....)
  wait(opts) {
    opts = defaults(opts, {
      until: required, // waits until "until(@)" evaluates to something truthy
      timeout: 30, // in *seconds* -- set to 0 to disable (sort of DANGEROUS, obviously.)
      cb: required
    }); // cb(undefined, until(@)) on success and cb('timeout') on failure due to timeout; cb('closed') if closed
    if (this.state === "closed") {
      // instantly fail -- table is closed so can't wait for anything
      opts.cb("closed");
      return;
    }
    let x = opts.until(this);
    if (x) {
      opts.cb(undefined, x); // already true
      return;
    }
    let fail_timer = undefined;
    var f = () => {
      x = opts.until(this);
      if (x) {
        this.removeListener("change", f);
        if (fail_timer != null) {
          clearTimeout(fail_timer);
          fail_timer = undefined;
        }
        return opts.cb(undefined, x);
      }
    };
    this.on("change", f);
    if (opts.timeout) {
      const fail = () => {
        this.removeListener("change", f);
        return opts.cb("timeout");
      };
      fail_timer = setTimeout(fail, 1000 * opts.timeout);
    }
  }
}

const synctables = {};

// for debugging; in particular, verify that synctables are freed.
// Do not leave in production; could be slight security risk.
//# window?.synctables = synctables

export function sync_table(
  query,
  options,
  client,
  debounce_interval = 2000,
  throttle_changes = undefined,
  use_cache = true
) {
  const cache_key = json_stable_stringify({
    query,
    options,
    debounce_interval,
    throttle_changes
  });
  if (!use_cache) {
    return new SyncTable(
      query,
      options,
      client,
      debounce_interval,
      throttle_changes,
      cache_key
    );
  }

  let S = synctables[cache_key];
  if (S != null) {
    if (S._state === "connected") {
      // same behavior as newly created synctable
      async.nextTick(function() {
        if (S._state === "connected") {
          return S.emit("connected");
        }
      });
    }
    S._reference_count += 1;
    return S;
  } else {
    S = synctables[cache_key] = new SyncTable(
      query,
      options,
      client,
      debounce_interval,
      throttle_changes,
      cache_key
    );
    S._reference_count = 1;
    return S;
  }
}

function global_cache_decref(S: SyncTable): boolean {
  if (S._reference_count != null) {
    S._reference_count -= 1;
    if (S._reference_count <= 0) {
      delete synctables[S._cache_key];
      return false; // not in use
    } else {
      return true; // still in use
    }
  }
}
