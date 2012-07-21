(function () {

  // internal verifier collection. Never published.
  Meteor.accounts._srpChallenges = new Meteor.Collection(
    "accounts._srpChallenges",
    null /*manager*/,
    null /*driver*/,
    true /*preventAutopublish*/);

  var selectorFromUserQuery = function (user) {
    if (!user)
      throw new Meteor.Error("Must pass a user property in request");
    if (_.keys(user).length !== 1)
      throw new Meteor.Error("User property must have exactly one field");

    var selector;
    if (user.id)
      selector = {_id: user.id};
    else if (user.username)
      selector = {username: user.username};
    else if (user.email)
      selector = {emails: user.email};
    else
      throw new Meteor.Error("Must pass username, email, or id in request.user");

    return selector;
  };

  // onCreateUser hook
  var onCreateUserHook = null;
  Meteor.accounts.onCreateUser = function (func) {
    if (onCreateUserHook)
      throw new Meteor.Error("Can only call onCreateUser once");
    else
      onCreateUserHook = func;
  };

  Meteor.methods({
    // @param request {Object} with fields:
    //   user: either {username: (username)}, {email: (email)}, or {id: (userId)}
    //   A: hex encoded int. the client's public key for this exchange
    // @returns {Object} with fields:
    //   identiy: string uuid
    //   salt: string uuid
    //   B: hex encoded int. server's public key for this exchange
    beginPasswordExchange: function (request) {
      var selector = selectorFromUserQuery(request.user);

      var user = Meteor.users.findOne(selector);
      if (!user)
        throw new Meteor.Error("user not found");

      if (!user.services || !user.services.password ||
          !user.services.password.srp)
        throw new Meteor.Error("user has no password set");

      var verifier = user.services.password.srp;
      var srp = new Meteor._srp.Server(verifier);
      var challenge = srp.issueChallenge({A: request.A});

      // XXX It would be better to put this on the session
      // somehow. However, this gets complicated when interacting with
      // reconnect on the client. The client should detect the reconnect
      // and re-start the exchange.
      // https://app.asana.com/0/988582960612/1278583012594
      //
      // Instead we store M and HAMK from SRP (abstraction violation!)
      // and let any session login if it knows M. This is somewhat
      // insecure, if you don't use SSL someone can sniff your traffic
      // and then log in as you (but no more insecure than reconnect
      // tokens).
      var serialized = { userId: user._id, M: srp.M, HAMK: srp.HAMK };
      Meteor.accounts._srpChallenges.insert(serialized);

      return challenge;
    },

    changePassword: function (options) {
      if (!this.userId())
        throw new Meteor.Error("must be logged in");

      // If options.M is set, it means we went through a challenge with
      // the old password.

      // XXX && Meteor.accounts.config.unsafePasswordChanges check here!
      if (!options.M) {
        throw new Meteor.Error("XXX no oldPassword unimplemented");
      }

      if (options.M) {
        var serialized = Meteor.accounts._srpChallenges.findOne(
          {M: options.M});
        if (!serialized)
          throw new Meteor.Error("bad password");
        if (serialized.userId !== this.userId())
          // No monkey business!
          throw new Meteor.Error("bad password");
      }

      var verifier = options.srp;
      if (!verifier && options.password) {
        verifier = Meteor._srp.generateVerifier(options.password);
      }
      if (!verifier || !verifier.identity || !verifier.salt ||
          !verifier.verifier)
        throw new Meteor.Error("Invalid verifier");

      Meteor.users.update({_id: this.userId()},
                          {$set: {'services.password.srp': verifier}});

      var ret = {passwordChanged: true};
      if (serialized)
        ret.HAMK = serialized.HAMK;
      return ret;
    },

    createUser: function (options, extra) {
      var username = options.username;
      if (!username)
        throw new Meteor.Error("need to set a username");

      if (Meteor.users.findOne({username: username}))
        throw new Meteor.Error("user already exists");

      // XXX validate verifier

      // raw password, should only be used over SSL!
      if (options.password) {
        if (options.srp)
          throw new Meteor.Error(400, "Don't pass both password and srp in options");
        options.srp = Meteor._srp.generateVerifier(
          options.password, {identity: username});
      }

      var user = {services: {password: {srp: options.srp}}};
      if (options.username)
        user.username = options.username;
      if (options.email)
        user.emails = [options.email];

      // xcxc get rid of fields: services, private, username, email
      if (onCreateUserHook) {
        user = onCreateUserHook(options, extra, user);
        // xcxc we need to get extra out of this, or alternative
        // change the signature of updateOrCreateUser to just get one
        // user object
      }

      // xcxc copy over extra, without the special fields (see other xcxc referring to Meteor.accounts.guardedFields)

      var userId = Meteor.users.insert(user);

      var loginToken = Meteor.accounts._loginTokens.insert({userId: userId});
      this.setUserId(userId);
      return {token: loginToken, id: userId};
    }
  });

  // xcxc BIG: Meteor.accounts.config
  // xcxc ~BIG: Meteor.accounts.validateNewUser

  // handler to login with password
  Meteor.accounts.registerLoginHandler(function (options) {
    if (!options.srp)
      return undefined; // don't handle
    if (!options.srp.M)
      throw new Meteor.Error("must pass M in options.srp");

    var serialized = Meteor.accounts._srpChallenges.findOne(
      {M: options.srp.M});
    if (!serialized)
      throw new Meteor.Error("bad password");

    var userId = serialized.userId;
    var loginToken = Meteor.accounts._loginTokens.insert({userId: userId});

    // XXX we should remove srpChallenge documents from mongo, but we
    // need to make sure reconnects still work (meaning we can't
    // remove them right after they've been used). This will also be
    // fixed if we store challenges in session.
    // https://app.asana.com/0/988582960612/1278583012594

    return {token: loginToken, id: userId, HAMK: serialized.HAMK};
  });

  // handler to login with plaintext password.
  //
  // The meteor client doesn't use this, it is for other DDP clients who
  // haven't implemented SRP. Since it sends the password in plaintext
  // over the wire, it should only be run over SSL!
  //
  // Also, it might be nice if servers could turn this off. Or maybe it
  // should be opt-in, not opt-out? Meteor.accounts.config option?
  Meteor.accounts.registerLoginHandler(function (options) {
    if (!options.password || !options.user)
      return undefined; // don't handle

    var selector = selectorFromUserQuery(options.user);
    var user = Meteor.users.findOne(selector);
    if (!user)
      throw new Meteor.Error("user not found");

    if (!user.services || !user.services.password ||
        !user.services.password.srp)
      throw new Meteor.Error("user has no password set");

    // Just check the verifier output when the same identity and salt
    // are passed. Don't bother with a full exchange.
    var verifier = user.services.password.srp;
    var newVerifier = Meteor._srp.generateVerifier(options.password, {
      identity: verifier.identity, salt: verifier.salt});

    if (verifier.verifier !== newVerifier.verifier)
      throw new Meteor.Error("bad password");

    var loginToken = Meteor.accounts._loginTokens.insert({userId: user._id});
    return {token: loginToken, id: user._id};
  });

})();
