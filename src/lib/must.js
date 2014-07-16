var must = {};

must._toString = function (thing) {
	return Object.prototype.toString.call(thing).slice(8, -1);
};

must.beString = function (s) {
	if (typeof s !== "string") {
		var type = this._toString(s);
		throw new Error("Assertion failed: expected string, instead got " + type);
	}
};

must.beArray = function (o) {
	if (!Array.isArray(o)) {
		var type = this._toString(o);
		throw new Error("Assertion failed: expected Array, instead got " + type);
	}
};

must.beObject = function (o) {
	var type = this._toString(o);
	if (type !== "Object") {
		throw new Error("Assertion failed: expected Object, instead got " + type);
	}
};
