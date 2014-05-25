(function (root, factory) {
    if (typeof define === "function" && define.amd) {
        define(factory);
    } else if (typeof exports === "object") {
        module.exports = factory();
    } else {
        root.Asteroid = factory();
    }
}(this, function () {

"use strict";

var Q = (function () {

    "use strict";

    var ayepromise = function (value) {
		if (ayepromise.isPromise(value)) {
			return value;
		}
        var wrapped = ayepromise.defer();
        wrapped.resolve(value);
        return wrapped.promise;
    };

    /* Wrap an arbitrary number of functions and allow only one of them to be
       executed and only once */
    var once = function () {
        var wasCalled = false;

        return function wrapper(wrappedFunction) {
            return function () {
                if (wasCalled) {
                    return;
                }
                wasCalled = true;
                wrappedFunction.apply(null, arguments);
            };
        };
    };

    var getThenableIfExists = function (obj) {
        // Make sure we only access the accessor once as required by the spec
        var then = obj && obj.then;

        if (typeof obj === "object" && typeof then === "function") {
            // Bind function back to it"s object (so fan"s of "this" don"t get sad)
            return function() { return then.apply(obj, arguments); };
        }
    };

    var aThenHandler = function (onFulfilled, onRejected) {
        var defer = ayepromise.defer();

        var doHandlerCall = function (func, value) {
            setTimeout(function () {
                var returnValue;
                try {
                    returnValue = func(value);
                } catch (e) {
                    defer.reject(e);
                    return;
                }

                if (returnValue === defer.promise) {
                    defer.reject(new TypeError("Cannot resolve promise with itself"));
                } else {
                    defer.resolve(returnValue);
                }
            }, 1);
        };

        var callFulfilled = function (value) {
            if (onFulfilled && onFulfilled.call) {
                doHandlerCall(onFulfilled, value);
            } else {
                defer.resolve(value);
            }
        };

        var callRejected = function (value) {
            if (onRejected && onRejected.call) {
                doHandlerCall(onRejected, value);
            } else {
                defer.reject(value);
            }
        };

        return {
            promise: defer.promise,
            handle: function (state, value) {
                if (state === FULFILLED) {
                    callFulfilled(value);
                } else {
                    callRejected(value);
                }
            }
        };
    };

    // States
    var PENDING = 0,
        FULFILLED = 1,
        REJECTED = 2;

    ayepromise.defer = function () {
        var state = PENDING,
            outcome,
            thenHandlers = [];

        var doSettle = function (settledState, value) {
            state = settledState;
            // persist for handlers registered after settling
            outcome = value;

            thenHandlers.forEach(function (then) {
                then.handle(state, outcome);
            });

            // Discard all references to handlers to be garbage collected
            thenHandlers = null;
        };

        var doFulfill = function (value) {
            doSettle(FULFILLED, value);
        };

        var doReject = function (error) {
            doSettle(REJECTED, error);
        };

        var registerThenHandler = function (onFulfilled, onRejected) {
            var thenHandler = aThenHandler(onFulfilled, onRejected);

            if (state === PENDING) {
                thenHandlers.push(thenHandler);
            } else {
                thenHandler.handle(state, outcome);
            }

            return thenHandler.promise;
        };

        var safelyResolveThenable = function (thenable) {
            // Either fulfill, reject or reject with error
            var onceWrapper = once();
            try {
                thenable(
                    onceWrapper(transparentlyResolveThenablesAndSettle),
                    onceWrapper(doReject)
                );
            } catch (e) {
                onceWrapper(doReject)(e);
            }
        };

        var transparentlyResolveThenablesAndSettle = function (value) {
            var thenable;

            try {
                thenable = getThenableIfExists(value);
            } catch (e) {
                doReject(e);
                return;
            }

            if (thenable) {
                safelyResolveThenable(thenable);
            } else {
                doFulfill(value);
            }
        };

        var onceWrapper = once();
        return {
            resolve: onceWrapper(transparentlyResolveThenablesAndSettle),
            reject: onceWrapper(doReject),
            promise: {
                then: registerThenHandler,
                fail: function (onRejected) {
                    return registerThenHandler(null, onRejected);
                },
                isFulfilled: function () {
                    return state === FULFILLED;
                },
                isRejected: function () {
                    return state === REJECTED;
                },
                isPending: function () {
                    return state === PENDING;
                },
				inspect: function () {
					var details = {};
					if (state === PENDING) {
						details.state = "pending";
					} else if (state === FULFILLED) {
						details.state = "fulfilled";
						details.value = outcome;
					} else if (state === REJECTED) {
						details.state = "rejected";
						details.reason = outcome;
					}
					return details;
				}
            }
        };
    };

    ayepromise.isPromise = function (promise) {
        return (promise && typeof promise.then === "function");
    };

    return ayepromise;
})();

var DDP = (function () {

	"use strict";

	var uniqueId = (function () {
		var i = 0;
		return function () {
			return (i++).toString();
		};
	})();

	var INIT_DDP_MESSAGE = "{\"server_id\":\"0\"}";
	var MAX_RECONNECT_ATTEMPTS = 10;
	var TIMER_INCREMENT = 500;
	var DEFAULT_PING_INTERVAL = 10000;
	var DDP_SERVER_MESSAGES = [
		"added", "changed", "connected", "error", "failed",
		"nosub", "ready", "removed", "result", "updated",
		"ping", "pong"
	];

	var DDP = function (options) {

		// Configuration
		this._endpoint = options.endpoint;
		this._SocketConstructor = options.SocketConstructor;
		this._autoreconnect = !options.do_not_autoreconnect;
		this._ping_interval = options._ping_interval || DEFAULT_PING_INTERVAL;
		this._debug = options.debug;

		// Subscriptions callbacks
		this._onReadyCallbacks   = {};
		this._onStopCallbacks   = {};
		this._onErrorCallbacks   = {};

		// Methods callbacks
		this._onResultCallbacks  = {};
		this._onUpdatedCallbacks = {};
		this._events = {};
		this._queue = [];

		// Setup
		this.readyState = -1;
		this._reconnect_count = 0;
		this._reconnect_incremental_timer = 0;

		// Init
		if (!options.do_not_autoconnect) this.connect();
	};
	DDP.prototype.constructor = DDP;

	DDP.prototype.connect = function () {
		this.readyState = 0;
		this._socket = new this._SocketConstructor(this._endpoint);
		this._socket.onopen	= this._on_socket_open.bind(this);
		this._socket.onmessage = this._on_socket_message.bind(this);
		this._socket.onerror   = this._on_socket_error.bind(this);
		this._socket.onclose   = this._on_socket_close.bind(this);
	};

	DDP.prototype.method = function (name, params, onResult, onUpdated) {
		var id = uniqueId();
		this._onResultCallbacks[id] = onResult;
		this._onUpdatedCallbacks[id] = onUpdated;
		this._send({
			msg: "method",
			id: id,
			method: name,
			params: params
		});
		return id;
	};

	DDP.prototype.sub = function (name, params, onReady, onStop, onError) {
		var id = uniqueId();
		this._onReadyCallbacks[id] = onReady;
		this._onStopCallbacks[id] = onStop;
		this._onErrorCallbacks[id] = onError;
		this._send({
			msg: "sub",
			id: id,
			name: name,
			params: params
		});
		return id;
	};

	DDP.prototype.unsub = function (id) {
		this._send({
			msg: "unsub",
			id: id
		});
	};

	DDP.prototype.on = function (name, handler) {
		this._events[name] = this._events[name] || [];
		this._events[name].push(handler);
	};

	DDP.prototype.off = function (name, handler) {
		if (!this._events[name]) return;
		this._events[name].splice(this._events[name].indexOf(handler), 1);
	};

	DDP.prototype._emit = function (name /* , arguments */) {
		if (!this._events[name]) return;
		var args = arguments;
		var self = this;
		this._events[name].forEach(function (handler) {
			handler.apply(self, Array.prototype.slice.call(args, 1));
		});
	};

	DDP.prototype._send = function (object) {
		if (this.readyState !== 1 && object.msg !== "connect") {
			this._queue.push(object);
			return;
		}
		var message;
		if (typeof EJSON === "undefined") {
			message = JSON.stringify(object);
		} else {
			message = EJSON.stringify(object);
		}
		if (this._debug) {
			console.log(message);
		}
		this._socket.send(message);
	};

	DDP.prototype._try_reconnect = function () {
		if (this._reconnect_count < MAX_RECONNECT_ATTEMPTS) {
			setTimeout(this.connect.bind(this), this._reconnect_incremental_timer);
		}
		this._reconnect_count += 1;
		this._reconnect_incremental_timer += TIMER_INCREMENT * this._reconnect_count;
	};

	DDP.prototype._on_result = function (data) {
		if (this._onResultCallbacks[data.id]) {
			this._onResultCallbacks[data.id](data.error, data.result);
			delete this._onResultCallbacks[data.id];
			if (data.error) delete this._onUpdatedCallbacks[data.id];
		} else {
			if (data.error) {
				delete this._onUpdatedCallbacks[data.id];
				throw data.error;
			}
		}
	};
	DDP.prototype._on_updated = function (data) {
		var self = this;
		data.methods.forEach(function (id) {
			if (self._onUpdatedCallbacks[id]) {
				self._onUpdatedCallbacks[id]();
				delete self._onUpdatedCallbacks[id];
			}
		});
	};
	DDP.prototype._on_nosub = function (data) {
		if (data.error) {
			if (!this._onErrorCallbacks[data.id]) {
				delete this._onReadyCallbacks[data.id];
				delete this._onStopCallbacks[data.id];
				throw new Error(data.error);
			}
			this._onErrorCallbacks[data.id](data.error);
			delete this._onReadyCallbacks[data.id];
			delete this._onStopCallbacks[data.id];
			delete this._onErrorCallbacks[data.id];
			return;
		}
		if (this._onStopCallbacks[data.id]) {
			this._onStopCallbacks[data.id]();
		}
		delete this._onReadyCallbacks[data.id];
		delete this._onStopCallbacks[data.id];
		delete this._onErrorCallbacks[data.id];
	};
	DDP.prototype._on_ready = function (data) {
		var self = this;
		data.subs.forEach(function (id) {
			if (self._onReadyCallbacks[id]) {
				self._onReadyCallbacks[id]();
				delete self._onReadyCallbacks[id];
			}
		});
	};

	DDP.prototype._on_error = function (data) {
		this._emit("error", data);
	};
	DDP.prototype._on_connected = function (data) {
		var self = this;
		var firstCon = self._reconnect_count === 0;
		var eventName = firstCon ? "connected" : "reconnected";
		self.readyState = 1;
		self._reconnect_count = 0;
		self._reconnect_incremental_timer = 0;
		var length = self._queue.length;
		for (var i=0; i<length; i++) {
			self._send(self._queue.shift());
		}
		self._emit(eventName, data);
		// Set up keepalive ping-s
		self._ping_interval_handle = setInterval(function () {
			var id = uniqueId();
			self._send({
				msg: "ping",
				id: id
			});
		}, self._ping_interval);
	};
	DDP.prototype._on_failed = function (data) {
		this.readyState = 4;
		this._emit("failed", data);
	};
	DDP.prototype._on_added = function (data) {
		this._emit("added", data);
	};
	DDP.prototype._on_removed = function (data) {
		this._emit("removed", data);
	};
	DDP.prototype._on_changed = function (data) {
		this._emit("changed", data);
	};
	DDP.prototype._on_ping = function (data) {
		this._send({
			msg: "pong",
			id: data.id
		});
	};
	DDP.prototype._on_pong = function (data) {
		// For now, do nothing.
	};

	DDP.prototype._on_socket_close = function () {
		clearInterval(this._ping_interval_handle);
		this.readyState = 4;
		this._emit("socket_close");
		if (this._autoreconnect) this._try_reconnect();
	};
	DDP.prototype._on_socket_error = function (e) {
		clearInterval(this._ping_interval_handle);
		this.readyState = 4;
		this._emit("socket_error", e);
	};
	DDP.prototype._on_socket_open = function () {
		this._send({
			msg: "connect",
			version: "pre1",
			support: ["pre1"]
		});
	};
	DDP.prototype._on_socket_message = function (message) {
		var data;
		if (this._debug) console.log(message);
		if (message.data === INIT_DDP_MESSAGE) return;
		try {
			if (typeof EJSON === "undefined") {
				data = JSON.parse(message.data);
			} else {
				data = EJSON.parse(message.data);
			}
			if (DDP_SERVER_MESSAGES.indexOf(data.msg) === -1) throw new Error();
		} catch (e) {
			console.warn("Non DDP message received:");
			console.warn(message.data);
			return;
		}
		this["_on_" + data.msg](data);
	};

	return DDP;

})();

function clone (obj) {
	if (typeof EJSON !== "undefined") {
		return EJSON.clone(obj);
	}
	var type = typeof obj;
	switch (type) {
		case "undefined":
		case "function":
			return undefined;
		case "string":
		case "number":
		case "boolean":
			return obj;
		case "object":
			if (obj === null) {
				return null;
			}
			return JSON.parse(JSON.stringify(obj));
		default:
			return;
	}
}

var EventEmitter = function () {};

EventEmitter.prototype = {

	constructor: EventEmitter,

	on: function (name, handler) {
		if (!this._events) this._events = {};
		this._events[name] = this._events[name] || [];
		this._events[name].push(handler);
	},

	off: function (name, handler) {
		if (!this._events) this._events = {};
		if (!this._events[name]) return;
		this._events[name].splice(this._events[name].indexOf(handler), 1);
	},

	_emit: function (name /* , arguments */) {
		if (!this._events) this._events = {};
		if (!this._events[name]) return;
		var args = arguments;
		var self = this;
		this._events[name].forEach(function (handler) {
			handler.apply(self, Array.prototype.slice.call(args, 1));
		});
	}

};

function formQs (obj) {
	var qs = "";
	for (var key in obj) {
		qs += key + "=" + obj[key] + "&";
	}
	qs = qs.slice(0, -1);
	return qs;
}

function guid () {
	var ret = "";
	for (var i=0; i<8; i++) {
		ret += Math.floor((1 + Math.random()) * 0x10000).toString(16).substring(1);
	}
	return ret;
}

function isEmail (string) {
	return string.indexOf("@") !== -1;
}

function isEqual (obj1, obj2) {
	var str1 = JSON.stringify(obj1);
	var str2 = JSON.stringify(obj2);
	return str1 === str2;
}

var must = {};

must._toString = function (thing) {
	return Object.prototype.toString.call(thing).slice(8, -1);
};

must.beString = function (s) {
	var type = this._toString(s);
	if (type !== "String") {
		throw new Error("Assertion failed: expected String, instead got " + type);
	}
};

must.beArray = function (o) {
	var type = this._toString(o);
	if (type !== "Array") {
		throw new Error("Assertion failed: expected Array, instead got " + type);
	}
};

must.beObject = function (o) {
	var type = this._toString(o);
	if (type !== "Object") {
		throw new Error("Assertion failed: expected Object, instead got " + type);
	}
};

///////////////////////////
// Environment detection //
///////////////////////////

var ENV = (typeof window === "undefined") ? "node" : "browser";



///////////////////////
// Node dependencies //
///////////////////////

if (ENV === "node") {
	var FayeWebSocket = require("faye-websocket");
}



//////////////////////////
// Asteroid constructor //
//////////////////////////

var Asteroid = function (host, ssl, debug) {
	// Assert arguments type
	must.beString(host);
	// Configure the instance
	this._host = (ssl ? "https://" : "http://") + host;
	if (ENV === "browser") {
		// If SockJS is available, use it, otherwise, use WebSocket
		// Note: SockJS is required for IE9 support
		if (typeof SockJS === "function") {
			this._ddpOptions = {
				endpoint: (ssl ? "https://" : "http://") + host + "/sockjs",
				SocketConstructor: SockJS,
				debug: debug
			};
		} else {
			this._ddpOptions = {
				endpoint: (ssl ? "wss://" : "ws://") + host + "/websocket",
				SocketConstructor: WebSocket,
				debug: debug
			};
		}
	}
	if (ENV === "node") {
		this._ddpOptions = {
			endpoint: (ssl ? "wss://" : "ws://") + host + "/websocket",
			SocketConstructor: FayeWebSocket.Client,
			debug: debug
		};
	}
	// Reference containers
	this.collections = {};
	this.subscriptions = {};
	// Init the instance
	this._init();
};
// Asteroid instances are EventEmitter-s
Asteroid.prototype = Object.create(EventEmitter.prototype);
Asteroid.prototype.constructor = Asteroid;



////////////////////////////////
// Establishes the connection //
////////////////////////////////

Asteroid.prototype._init = function () {
	var self = this;
	// Creates the DDP instance, that will automatically
	// connect to the DDP server.
	self.ddp = new DDP(this._ddpOptions);
	// Register handlers
	self.ddp.on("connected", function () {
		if (ENV === "browser") {
			// Upon connection try resuming login
			// Save the pormise it returns
			self.resumeLoginPromise = self._tryResumeLogin();
		}
		// Subscribe to the meteor.loginServiceConfiguration
		// collection, which holds the configuration options
		// to login via third party services (oauth).
		self.ddp.sub("meteor.loginServiceConfiguration");
		// Emit the connected event
		self._emit("connected");
	});
	self.ddp.on("reconnected", function () {
		if (ENV === "browser") {
			// Upon reconnection try resuming login
			// Save the pormise it returns
			self.resumeLoginPromise = self._tryResumeLogin();
		}
		// Re-establish all previously established (and still active) subscriptions
		self._reEstablishSubscriptions();
		// Emit the reconnected event
		self._emit("reconnected");
	});
	self.ddp.on("added", function (data) {
		self._onAdded(data);
	});
	self.ddp.on("changed", function (data) {
		self._onChanged(data);
	});
	self.ddp.on("removed", function (data) {
		self._onRemoved(data);
	});
};



///////////////////////////////////////
// Handler for the ddp "added" event //
///////////////////////////////////////

Asteroid.prototype._onAdded = function (data) {
	// Get the name of the collection
	var cName = data.collection;
	// If the collection does not exist yet, create it
	if (!this.collections[cName]) {
		this.collections[cName] = new Asteroid._Collection(cName, this);
	}
	// data.fields can be undefined if the item added has only
	// the _id field . To avoid errors down the line, ensure item
	// is an object.
	var item = data.fields || {};
	item._id = data.id;
	// Perform the remote insert
	this.collections[cName]._remoteToLocalInsert(item);
};



/////////////////////////////////////////
// Handler for the ddp "removed" event //
/////////////////////////////////////////

Asteroid.prototype._onRemoved = function (data) {
	// Check the collection exists to avoid exceptions
	if (!this.collections[data.collection]) {
		return;
	}
	// Perform the reomte remove
	this.collections[data.collection]._remoteToLocalRemove(data.id);
};



/////////////////////////////////////////
// Handler for the ddp "changes" event //
/////////////////////////////////////////

Asteroid.prototype._onChanged = function (data) {
	// Check the collection exists to avoid exceptions
	if (!this.collections[data.collection]) {
		return;
	}
	// data.fields can be undefined if the update only
	// removed some properties in the item. Make sure
	// it's an object
	if (!data.fields) {
		data.fields = {};
	}
	// If there were cleared fields, explicitly set them
	// to undefined in the data.fields object. This will
	// cause those fields to be present in the for ... in
	// loop the remote update method of the collection
	// performs, causing then the fields to be actually
	// cleared from the item
	if (data.cleared) {
		data.cleared.forEach(function (key) {
			data.fields[key] = undefined;
		});
	}
	// Perform the remote update
	this.collections[data.collection]._remoteToLocalUpdate(data.id, data.fields);
};







////////////////////////////
// Call and apply methods //
////////////////////////////

Asteroid.prototype.call = function (method /* , param1, param2, ... */) {
	// Assert arguments type
	must.beString(method);
	// Get the parameters for apply
	var params = Array.prototype.slice.call(arguments, 1);
	// Call apply
	return this.apply(method, params);
};

Asteroid.prototype.apply = function (method, params) {
	// Assert arguments type
	must.beString(method);
	// If no parameters are given, use an empty array
	if (!Array.isArray(params)) {
		params = [];
	}
	// Create the result and updated promises
	var resultDeferred = Q.defer();
	var updatedDeferred = Q.defer();
	var onResult = function (err, res) {
		// The onResult handler takes care of errors
		if (err) {
			// If errors ccur, reject both promises
			resultDeferred.reject(err);
			updatedDeferred.reject();
		} else {
			// Otherwise resolve the result one
			resultDeferred.resolve(res);
		}
	};
	var onUpdated = function () {
		// Just resolve the updated promise
		updatedDeferred.resolve();
	};
	// Perform the method call
	this.ddp.method(method, params, onResult, onUpdated);
	// Return an object containing both promises
	return {
		result: resultDeferred.promise,
		updated: updatedDeferred.promise
	};
};



/////////////////////
// Syntactic sugar //
/////////////////////

Asteroid.prototype.createCollection = function (name) {
	// Assert arguments type
	must.beString(name);
	// Only create the collection if it doesn't exist
	if (!this.collections[name]) {
		this.collections[name] = new Asteroid._Collection(name, this);
	}
	return this.collections[name];
};

///////////////////////////////////////////
// Removal and update suffix for backups //
///////////////////////////////////////////

var mf_removal_suffix = "__del__";
var mf_update_suffix = "__upd__";
var is_backup = function (id) {
	var l1 = mf_removal_suffix.length;
	var l2 = mf_update_suffix.length;
	var s1 = id.slice(-1 * l1);
	var s2 = id.slice(-1 * l2);
	return s1 === mf_removal_suffix || s2 === mf_update_suffix;
};



/////////////////////////////////////////////
// Collection class constructor definition //
/////////////////////////////////////////////

var Collection = function (name, asteroidRef) {
	this.name = name;
	this.asteroid = asteroidRef;
	this._set = new Set();
};
Collection.prototype.constructor = Collection;



///////////////////////////////////////////////
// Insert-related private and public methods //
///////////////////////////////////////////////

Collection.prototype._localToLocalInsert = function (item) {
	// If an item by that id already exists, raise an exception
	if (this._set.contains(item._id)) {
		throw new Error("Item " + item._id + " already exists");
	}
	this._set.put(item._id, item);
	// Return a promise, just for api consistency
	return Q(item._id);
};
Collection.prototype._remoteToLocalInsert = function (item) {
	// The server is the SSOT, add directly
	this._set.put(item._id, item);
};
Collection.prototype._localToRemoteInsert = function (item) {
	var self = this;
	var deferred = Q.defer();
	// Construct the name of the method we need to call
	var methodName = "/" + self.name + "/insert";
	self.asteroid.ddp.method(methodName, [item], function (err, res) {
		if (err) {
			// On error restore the database and reject the promise
			self._set.del(item._id);
			deferred.reject(err);
		} else {
			// Else resolve the promise
			deferred.resolve(item._id);
		}
	});
	return deferred.promise;
};
Collection.prototype.insert = function (item) {
	// If the time has no id, generate one for it
	if (!item._id) {
		item._id = guid();
	}
	return {
		// Perform the local insert
		local: this._localToLocalInsert(item),
		// Send the insert request
		remote: this._localToRemoteInsert(item)
	};
};



///////////////////////////////////////////////
// Remove-related private and public methods //
///////////////////////////////////////////////

Collection.prototype._localToLocalRemove = function (id) {
	// Check if the item exists in the database
	var existing = this._set.get(id);
	if (existing) {
		// Create a backup of the object to delete
		this._set.put(id + mf_removal_suffix, existing);
		// Delete the object
		this._set.del(id);
	}
	// Return a promise, just for api consistency
	return Q(id);
};
Collection.prototype._remoteToLocalRemove = function (id) {
	// The server is the SSOT, remove directly (item and backup)
	this._set.del(id);
};
Collection.prototype._localToRemoteRemove = function (id) {
	var self = this;
	var deferred = Q.defer();
	// Construct the name of the method we need to call
	var methodName = "/" + self.name + "/remove";
	self.asteroid.ddp.method(methodName, [{_id: id}], function (err, res) {
		if (err) {
			// On error restore the database and reject the promise
			var backup = self._set.get(id + mf_removal_suffix);
			// Ensure there is a backup
			if (backup) {
				self._set.put(id, backup);
				self._set.del(id + mf_removal_suffix);
			}
			deferred.reject(err);
		} else {
			// Else, delete the (possible) backup and resolve the promise
			self._set.del(id + mf_removal_suffix);
			deferred.resolve(id);
		}
	});
	return deferred.promise;
};
Collection.prototype.remove = function (id) {
	return {
		// Perform the local remove
		local: this._localToLocalRemove(id),
		// Send the remove request
		remote: this._localToRemoteRemove(id)
	};
};



///////////////////////////////////////////////
// Update-related private and public methods //
///////////////////////////////////////////////

Collection.prototype._localToLocalUpdate = function (id, fields) {
	// Ensure the item actually exists
	var existing = this._set.get(id);
	if (!existing) {
		throw new Error("Item " + id + " doesn't exist");
	}
	// Ensure the _id property won't get modified
	if (fields._id && fields._id !== id) {
		throw new Error("Modifying the _id of a document is not allowed");
	}
	// Create a backup
	this._set.put(id + mf_update_suffix, existing);
	// Perform the update
	for (var field in fields) {
		existing[field] = fields[field];
	}
	this._set.put(id, existing);
	// Return a promise, just for api consistency
	return Q(id);
};
Collection.prototype._remoteToLocalUpdate = function (id, fields) {
	// Ensure the item exixts in the database
	var existing = this._set.get(id);
	if (!existing) {
		console.warn("Server misbehaviour: item " + id + " doesn't exist");
		return;
	}
	for (var field in fields) {
		// Ensure the server is not trying to moify the item _id
		if (field === "_id" && fields._id !== id) {
			console.warn("Server misbehaviour: modifying the _id of a document is not allowed");
			return;
		}
		existing[field] = fields[field];
	}
	// Perform the update
	this._set.put(id, existing);
};
Collection.prototype._localToRemoteUpdate = function (id, fields) {
	var self = this;
	var deferred = Q.defer();
	// Construct the name of the method we need to call
	var methodName = "/" + self.name + "/update";
	// Construct the selector
	var sel = {
		_id: id
	};
	// Construct the modifier
	var mod = {
		$set: fields
	};
	self.asteroid.ddp.method(methodName, [sel, mod], function (err, res) {
		if (err) {
			// On error restore the database and reject the promise
			var backup = self._set.get(id + mf_update_suffix);
			self._set.put(id, backup);
			self._set.del(id + mf_update_suffix);
			deferred.reject(err);
		} else {
			// Else, delete the (possible) backup and resolve the promise
			self._set.del(id + mf_update_suffix);
			deferred.resolve(id);
		}
	});
	return deferred.promise;
};
Collection.prototype.update = function (id, fields) {
	return {
		// Perform the local update
		local: this._localToLocalUpdate(id, fields),
		// Send the update request
		remote: this._localToRemoteUpdate(id, fields)
	};
};



//////////////////////////////
// Reactive queries methods //
//////////////////////////////

var ReactiveQuery = function (set) {
	var self = this;
	self.result = [];

	self._set = set;
	self._getResult();

	self._set.on("put", function (id) {
		self._getResult();
		self._emit("change", id);
	});
	self._set.on("del", function (id) {
		self._getResult();
		self._emit("change", id);
	});

};
ReactiveQuery.prototype = Object.create(EventEmitter.prototype);
ReactiveQuery.constructor = ReactiveQuery;

ReactiveQuery.prototype._getResult = function () {
	this.result = this._set.toArray();
};

var getFilterFromSelector = function (selector) {
	// Return the filter function
	return function (id, item) {

		// Filter out backups
		if (is_backup(id)) {
			return false;
		}

		// Get the value of the object from a compund key
		// (e.g. "profile.name.first")
		var getItemVal = function (item, key) {
			return key.split(".").reduce(function (prev, curr) {
				if (!prev) return prev;
				prev = prev[curr];
				return prev;
			}, item);
		};

		// Iterate all the keys in the selector. The first that
		// doesn't match causes the item to be filtered out.
		for (var key in selector) {
			var itemVal = getItemVal(item, key);
			if (itemVal !== selector[key]) {
				return false;
			}
		}

		// At this point the item matches the selector
		return true;

	};
};

Collection.prototype.reactiveQuery = function (selectorOrFilter) {
	var filter;
	if (typeof selectorOrFilter === "function") {
		filter = selectorOrFilter;
	} else {
		filter = getFilterFromSelector(selectorOrFilter);
	}
	var subset = this._set.filter(filter);
	return new ReactiveQuery(subset);
};



Asteroid._Collection = Collection;

if (ENV === "browser") {

	Asteroid.prototype._getOauthClientId = function (serviceName) {
		var loginConfigCollectionName = "meteor_accounts_loginServiceConfiguration";
		var loginConfigCollection = this.collections[loginConfigCollectionName];
		var service = loginConfigCollection.reactiveQuery({service: serviceName}).result[0];
		return service.clientId;
	};

	Asteroid.prototype._initOauthLogin = function (service, credentialToken, loginUrl) {
		var popup = window.open(loginUrl, "Login");
		var self = this;
		return Q()
			.then(function () {
				var deferred = Q.defer();
				if (popup.focus) popup.focus();
				var intervalId = setInterval(function () {
					if (popup.closed || popup.closed === undefined) {
						clearInterval(intervalId);
						deferred.resolve();
					}
				}, 100);
				return deferred.promise;
			})
			.then(function () {
				var deferred = Q.defer();
				var loginParameters = {
					oauth: {
						credentialToken: credentialToken
					}
				};
				self.ddp.method("login", [loginParameters], function (err, res) {
					if (err) {
						delete self.userId;
						delete self.loggedIn;
						delete localStorage[self._host + "__login_token__"];
						deferred.reject(err);
						self._emit("loginError", err);
					} else {
						self.userId = res.id;
						self.loggedIn = true;
						localStorage[self._host + "__login_token__"] = res.token;
						self._emit("login", res.id);
						deferred.resolve(res.id);
					}
				});
				return deferred.promise;
			});
	};

	Asteroid.prototype._tryResumeLogin = function () {
		var self = this;
		var deferred = Q.defer();
		var token = localStorage[self._host + "__login_token__"];
		if (!token) {
			deferred.reject("No login token");
			return deferred.promise;
		}
		var loginParameters = {
			resume: token
		};
		self.ddp.method("login", [loginParameters], function (err, res) {
			if (err) {
				delete self.userId;
				delete self.loggedIn;
				delete localStorage[self._host + "__login_token__"];
				self._emit("loginError", err);
				deferred.reject(err);
			} else {
				self.userId = res.id;
				self.loggedIn = true;
				localStorage[self._host + "__login_token__"] = res.token;
				self._emit("login", res.id);
				deferred.resolve(res.id);
			}
		});
		return deferred.promise;
	};

	Asteroid.prototype.loginWithFacebook = function (scope) {
		var credentialToken = guid();
		var query = {
			client_id:		this._getOauthClientId("facebook"),
			redirect_uri:	this._host + "/_oauth/facebook?close",
			state:			credentialToken,
			scope:			scope || "email"
		};
		var loginUrl = "https://www.facebook.com/dialog/oauth?" + formQs(query);
		return this._initOauthLogin("facebook", credentialToken, loginUrl);
	};

	Asteroid.prototype.loginWithGoogle = function (scope) {
		var credentialToken = guid();
		var query = {
			response_type:	"code",
			client_id:		this._getOauthClientId("google"),
			redirect_uri:	this._host + "/_oauth/google?close",
			state:			credentialToken,
			scope:			scope || "openid email"
		};
		var loginUrl = "https://accounts.google.com/o/oauth2/auth?" + formQs(query);
		return this._initOauthLogin("google", credentialToken, loginUrl);
	};

	Asteroid.prototype.loginWithGithub = function (scope) {
		var credentialToken = guid();
		var query = {
			client_id:		this._getOauthClientId("github"),
			redirect_uri:	this._host + "/_oauth/github?close",
			state:			credentialToken,
			scope:			scope || "email"
		};
		var loginUrl = "https://github.com/login/oauth/authorize?" + formQs(query);
		return this._initOauthLogin("github", credentialToken, loginUrl);
	};

	Asteroid.prototype.loginWithTwitter = function (scope) {
		var credentialToken = guid();
		var callbackUrl = this._host + "/_oauth/twitter?close&state=" + credentialToken;
		var query = {
			requestTokenAndRedirect:	encodeURIComponent(callbackUrl),
			state:						credentialToken
		};
		var loginUrl = this._host + "/_oauth/twitter/?" + formQs(query);
		return this._initOauthLogin("twitter", credentialToken, loginUrl);
	};

}

Asteroid.prototype.createUser = function (usernameOrEmail, password, profile) {
	var self = this;
	var deferred = Q.defer();
	var options = {
		username: isEmail(usernameOrEmail) ? undefined : usernameOrEmail,
		email: isEmail(usernameOrEmail) ? usernameOrEmail : undefined,
		password: password,
		profile: profile
	};
	self.ddp.method("createUser", [options], function (err, res) {
		if (err) {
			self._emit("createUserError", err);
			deferred.reject(err);
		} else {
			self.userId = res.id;
			self.loggedIn = true;
			localStorage[self._host + "__login_token__"] = res.token;
			self._emit("createUser", res.id);
			self._emit("login", res.id);
			deferred.resolve(res.id);
		}
	});
	return deferred.promise;
};

Asteroid.prototype.loginWithPassword = function (usernameOrEmail, password) {
	var self = this;
	var deferred = Q.defer();
	var loginParameters = {
		password: password,
		user: {
			username: isEmail(usernameOrEmail) ? undefined : usernameOrEmail,
			email: isEmail(usernameOrEmail) ? usernameOrEmail : undefined
		}
	};
	self.ddp.method("login", [loginParameters], function (err, res) {
		if (err) {
			delete self.userId;
			delete self.loggedIn;
			delete localStorage[self._host + "__login_token__"];
			deferred.reject(err);
			self._emit("loginError", err);
		} else {
			self.userId = res.id;
			self.loggedIn = true;
			localStorage[self._host + "__login_token__"] = res.token;
			self._emit("login", res.id);
			deferred.resolve(res.id);
		}
	});
	return deferred.promise;
};

Asteroid.prototype.logout = function () {
	var self = this;
	var deferred = Q.defer();
	self.ddp.method("logout", [], function (err, res) {
		if (err) {
			self._emit("logoutError", err);
			deferred.reject(err);
		} else {
			delete self.userId;
			delete self.loggedIn;
			delete localStorage[self._host + "__login_token__"];
			self._emit("logout");
			deferred.resolve();
		}
	});
	return deferred.promise;
};

var Set = function (readonly) {
	// Allow readonly sets
	if (readonly) {
		// Make the put and del methods private
		this._put = this.put;
		this._del = this.del;
		// Replace them with a throwy function
		this.put = this.del = function () {
			throw new Error("Attempt to modify readonly set");
		};
	}
	this._items = {};
};
// Inherit from EventEmitter
Set.prototype = Object.create(EventEmitter.prototype);
Set.constructor = Set;

Set.prototype.put = function (id, item) {
	// Assert arguments type
	must.beString(id);
	must.beObject(item);
	// Save a clone to avoid collateral damage
	this._items[id] = clone(item);
	this._emit("put", id);
	// Return the set instance to allow method chainging
	return this;
};

Set.prototype.del = function (id) {
	// Assert arguments type
	must.beString(id);
	delete this._items[id];
	this._emit("del", id);
	// Return the set instance to allow method chainging
	return this;
};

Set.prototype.get = function (id) {
	// Assert arguments type
	must.beString(id);
	// Return a clone to avoid collateral damage
	return clone(this._items[id]);
};

Set.prototype.contains = function (id) {
	// Assert arguments type
	must.beString(id);
	return !!this._items[id];
};

Set.prototype.filter = function (belongFn) {

	// Creates the subset
	var sub = new Set(true);

	// Keep a reference to the _items hash
	var items = this._items;

	// Performs the initial puts
	var ids = Object.keys(items);
	ids.forEach(function (id) {
		// Clone the element to avoid
		// collateral damage
		var itemClone = clone(items[id]);
		var belongs = belongFn(id, itemClone);
		if (belongs) {
			sub._items[id] = items[id];
		}
	});

	// Listens to the put and del events
	// to automatically update the subset
	this.on("put", function (id) {
		// Clone the element to avoid
		// collateral damage
		var itemClone = clone(items[id]);
		var belongs = belongFn(id, itemClone);
		if (belongs) {
			sub._put(id, items[id]);
		}
	});
	this.on("del", function (id) {
		sub._del(id);
	});

	// Returns the subset
	return sub;
};

Set.prototype.toArray = function () {
	var array = [];
	var items = this._items;
	var ids = Object.keys(this._items);
	ids.forEach(function (id) {
		array.push(items[id]);
	});
	// Return a clone to avoid collateral damage
	return clone(array);
};

Set.prototype.toHash = function () {
	// Return a clone to avoid collateral damage
	return clone(this._items);
};

Asteroid.Set = Set;

////////////////////////
// Subscription class //
////////////////////////

var Subscription = function (name, params, asteroid) {
	this._name = name;
	this._params = params;
	this._asteroid = asteroid;
	// Subscription promises
	this._ready = Q.defer();
	this.ready = this._ready.promise;
	// Subscribe via DDP
	var or = this._onReady.bind(this);
	var os = this._onStop.bind(this);
	var oe = this._onError.bind(this);
	this.id = asteroid.ddp.sub(name, params, or, os, oe);
};
Subscription.constructor = Subscription;

Subscription.prototype.stop = function () {
	this._asteroid.ddp.unsub(this.id);
};

Subscription.prototype._onReady = function () {
	this._ready.resolve();
};

Subscription.prototype._onStop = function () {
	delete this._asteroid.subscriptions[this.id];
};

Subscription.prototype._onError = function (err) {
	if (this.ready.isPending()) {
		this._ready.reject(err);
	}
	delete this._asteroid.subscriptions[this.id];
};



//////////////////////
// Subscribe method //
//////////////////////

Asteroid.prototype.subscribe = function (name /* , param1, param2, ... */) {
	// Assert arguments type
	must.beString(name);
	// Collect arguments into array
	var params = Array.prototype.slice.call(arguments, 1);
	var sub = new Subscription(name, params, this);
	this.subscriptions[sub.id] = sub;
	return sub;
};

Asteroid.prototype._reEstablishSubscriptions = function () {
	var subs = this.subscriptions;
	for (var id in subs) {
		subs[id] = new Subscription(subs[id]._name, subs[id]._params, this);
	}
};

return Asteroid;

}));
