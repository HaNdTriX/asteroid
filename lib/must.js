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
