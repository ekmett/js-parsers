define('parsers',[],function() {
  var parsers = {};

  /** Parsing combinators by Edward Kmett
    *
    * Note: These assume that the input is an array of tokens.
    */

  // local: union of two anonymous objects, favoring the right
  function union(m,n) {
    var o = {};
    for (var i in m) o[i] = m[i];
    for (var i in n) o[i] = n[i];
    return o;
  }

  // local: cons onto an array, immutably
  function cons(a,as) {
    return [a].concat(as);
  }

  // local: snoc onto an array, immutably
  function snoc(as, a) {
    return as.concat([a]);
  }

  function format(xs) {
    return xs.length === 0 ? "syntax error" : xs.join(", ");
  }

  // Err is used to hold errors.
  //
  // 'reason' is a list of explanations.
  //
  // 'expected' must be an anonymous object where every key is a string. The values can be used to carry whatever you want
  // but in the event of collision only the later one will be kept, so it is probably best that they be determined by the string.
  // if pos is null then we are implicitly talking about the current location.
  var Err = parsers.Err = function(reason, expected, pos) {
    this.reason   = reason;
    this.expected = typeof expected === 'undefined' ? {} : expected;
    this.pos      = pos; // null for any condition where we don't move the cursor
  };

  Err.prototype.at = function(d) {
      return new Err(this.reason, this.expected, d);
  };

  Err.prototype.merge = function(that) {
      if (this.pos > that.pos) return this;
      if (this.pos < that.pos) return that;
      return new Err(this.reason.concat(that.reason), union(this.expected,that.expected), this.pos);
  };

  Err.prototype.toString = Err.prototype.message = function() {
    var es = [];

    for (var i in this.expected)
      Array.prototype.push.apply(es,[i]);

    if (es.length == 0)
      return format(this.reason);

    if (this.reason === null)
      return "expected " + es.join(", ")

    return format(this.reason) + ", expected " + es.join(", ");
  };

  var ok = new Err([],{});

  // Parser is a type
  // go :: (Int, Input Array, a -> Err -> r, Err -> r, a -> Set -> Int -> r, Doc -> r) -> r
  var Parser = parsers.Parser = function(go) {
    this.go = go;
  };

  // fail with (or without) explanation
  var fail = parsers.fail = function(x) {
    return new Parser(function(d,i,kp,kf,kc,ke) {
      return kf(new Err(typeof x === 'undefined' ? [] : [x],{}))
    })
  };

  var pure = parsers.pure = function(a) {
    return new Parser(function(d,i,kp,kf,kc,ke) {
      return kp(a,ok)
    })
  };

  var Literal = parsers.Literal = function(body) { this.body = body; };

  Literal.prototype.toString = function() {
    return "<literal " + this.body + ">";
  };

  var satisfy = parsers.satisfy = function(p,desc,tag) {
    var es = {};
    es[desc] = typeof tag === 'undefined' ? new Literal(desc) : tag ;
    var er = new Err([],es);

    return new Parser(function(d,i,kp,kf,kc,ke) {
      if (d < i.length) {
        var c = i[d];
        return p(c) ? kc(c, {}, d + 1) : kf(er);
      } else {
        return kf(er); // eof
      }
    })
  };

  var EOF = parsers.EOF = function () {};

  EOF.prototype.toString = function() {
    return "<EOF>";
  };

  var eof_tag = new EOF();

  var eof = parsers.eof = new Parser(function(d,i,kp,kf,kc,ke) {
    return (d == i.length)
         ? kp(eof_tag, ok)
         : kf(new Err([],{"EOF": eof_tag}))
  });

  var literal = parsers.literal = function(s) {
    return satisfy(function(t) { return s == t; }, s, new Literal(s))
  };

  var lift = parsers.lift = function(e) {
    if (e instanceof Parser) return e;
    else if (typeof e === "string") return literal(e); // upgrade to a token parser
    else return literal(e.toString());
  }

  function seq_step(p,q) {
    return p.bind(function(xs) { return q.map(function(x) { return snoc(xs,x); })});
  }

  // build a parser from several arguments.
  //
  // seq is a variadic function
  //
  // seq("(",p,")")
  var seq = parsers.seq = function() {
    var p = pure([]);
    for (var i = 0; i < arguments.length; ++i)
      p = seq_step(p,lift(arguments[i]));
    return p;
  };

  function choose_step(p,q) {
    return p.or(q);
  }

  var choose = parsers.choose = function() {
    var p = fail();
    for (var i = 0; i < arguments.length; ++i)
      p = choose_step(p,lift(arguments[i]));
    return p;
  };

  Parser.prototype.toString = function() {
    return "<Parser>";
  };

  Parser.prototype.parse = function(xs,n) {
    if (typeof n === 'undefined') n = 0;
    return this.go(n,xs,
      function(a,e)   { return a },
      function(e)     { throw e.at(n) },
      function(a,s,d) { return a },
      function(msg)   { throw msg }
    )
  };

  // obtain the set of tokens that could be used to continue
  // returns a position in the token stream and a set of alternatives
  Parser.prototype.next = function(xs,n) {
    if (typeof n === 'undefined') n = 0;
    return this.go(n,xs,
      function(a,e)   { return { pos : n, expected : e.expected, result : a } },
      function(e)     { return { pos : n, expected : e.expected, message: e.at(n).message() } },
      function(a,s,d) { return { pos : d, expected : s, result : a } },
      function(e)     { return { pos : e.pos, expected : e.expected, message : e.message() } }
    )
  };

  Parser.prototype.map = function(f) {
    var p = this.go;
    return new Parser(function(d,i,kp,kf,kc,ke) {
      return p(d,i,
        function(a,e) { return kp(f(a),e) },
        kf,
        function(a,s,d2) { return kc(f(a),s,d2) },
        ke
      );
    });
  };

  Parser.prototype.as = function(a) {
    return this.map(function(_) { return a; })
  };

  // try: note, the reason argument is optional and may be null
  Parser.prototype.attempt = function(reason) {
    var p = this;
    return new Parser(function (d,i,kp,kf,kc,ke) {
      return p.go(d,i,kp,kf,kc,function(e) {
        return kf(new Err(reason,{}))
      })
    })
  };

  // (>>=)
  Parser.prototype.bind = function(f) {
    var p = this;
    return new Parser(function(d,i,kp,kf,kc,ke) {
      return p.go(d,i,
        function(a,e) { return f(a).go(d,i,kp,kf,kc,ke) },
        kf,
        function(a,s,d2) {
          return f(a).go(d2,i,
            function(b,e) { return kc(b,union(s,e.expected),d2) },
            function(e) { return ke((new Err([],s)).merge(e).at(d2)) },
            kc,
            ke
          )
        },
        ke
      )
    })
  };

  // <?>
  Parser.prototype.desc = function(s,t) {
    var p = this;
    return new Parser(function(d,i,kp,kf,kc,ke) {
      return p.go(d,i,
        function(a,e) { return kp(a, e.reason.length === 0 ? e : new Err(e.reason,{s:t})) },
        function(e)   { return kf(new Err(e.reason,{s:t})) },
        kc,
        ke
      )
    })
  };

  // <|>
  Parser.prototype.or = function(q) {
    var p = this;
    return new Parser(function(d,i,kp,kf,kc,ke) {
      return p.go(d,i,
        kp,
        function(e) {
          return q.go(d,i,
            function(a,e2) { return kp(a,e.merge(e2)) },
            function(e2)   { return kf(e.merge(e2)) },
            kc,
            ke
          )
        },
        kc,
        ke
      )
    })
  };

  Parser.prototype.race = function(q) {
    var p = this;
    return new Parser(function(d,i,kp,kf,kc,ke) { return p.go(d,i,
      function(a,e) { return q.go(d,i,
        function(a2,e2) { return kp(a,e.merge(e2)) },
        function(e2)    { return kp(a,e.merge(e2)) },
        kc,
        ke
      )},
      function(e) { return q.go(d,i,
        function(a2,e2) { return kp(a,e.merge(e2)) },
        function(e2)    { return kf(e.merge(e2)) },
        kc,
        ke
      )},
      function(a,s,d) { return q.go(d,i,
        function(a2,e2) { return kc(a,s,d) },
        function(e2)    { return kc(a,s,d) },
        function(a2,s2,d2) {
          return (d > d2) ? kc(a,s,d)
               : (d < d2) ? kc(a2,s2,d2)
                          : kc(a,union(s,s2),d)
        },
        function(m) {
          return (m.pos < d) ? kc(a,s,d)
               : (m.pos > d) ? kc(a,s,d)
                             : kc(a,union(s,m.expected),d)
        }
      )},
      function(m) { return q.go(d,i,
        kp,
        kf,
        function (a2,s2,d2) {
          return (m.pos < d2) ? kc(a2,s2,d2)
               : (m.pos > d2) ? kc(a2,s2,d2)
                              : kc(a2,union(m.expected,s2),d2)
        },
        function (m2) { return ke(m.merge(m2)) }
      )}
    )})
  };

  // accumulate many results provided a `snoc`-like function that takes the accumulator so far and the new value, and a base case
  Parser.prototype.manyAccum = function(f,z) {
    var p = this;
    return new Parser(function(d,i,kp,kf,kc,ke) {
      function empty(a,e) { throw "many: applied to a parser that accepts the empty string" }
      function walk(xs,x,s,d2) {
        return p.go(d2,i,
          empty,
          function(e)        { return kc(f(xs,x), union(e.expected, s), d2) },
          function(x2,s2,d3) { return walk(f(xs,x),x2,s2,d3) },
          ke
        );
      };
      return p.go(d,i,
        empty,
        function(e)      { return kp(z,e) },
        function(x,s,d2) { return walk(z,x,s,d2) },
        ke
      )
    })
  };

  Parser.prototype.many = function() {
    return this.manyAccum(snoc,[])
  };

  Parser.prototype.bracketed = function(p,q) {
    return seq(p,this,q).apply(function(x,y,z) { return y })
  };

  Parser.prototype.paren = function() {
    return this.bracketed("(",")")
  };

  Parser.prototype.phrase = function() {
    return this.bind(function(a) { return eof.as(a) })
  };

  Parser.prototype.then = function(q) {
    return this.bind(function(_) { return q })
  };

  Parser.prototype.sepBy1 = function(sep) {
    var p = this;
    return p.bind(function (x) { return sep.then(p).manyAccum(snoc,[x]); })
  };

  Parser.prototype.sepBy = function(sep) {
    return p.sepBy1(sep).or(pure([]))
  };

  // this permits calling an n argument function directly with the array of arguments we have
  Parser.prototype.apply = function(f) {
    return this.map(function (xs) { return f.apply(null, xs) })
  };

  // circular definition: see definition, circular
  var promise = parsers.promise = function(f) {
    var p = new Parser();
    p.go = f(p).go;
    return p;
  };

  Parser.prototype.foldr1 = function(f) {
    return this.map(function(xs) {
      var r = xs[xs.length-1];
      for (var i = xs.length - 2; i >= 0; --i)
        r = f(xs[i], r);
      return r;
    });
  }

  return parsers;
});
