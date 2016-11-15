var
  EventEmitter    = require('events');

/**
 * Creates a hyalineHash Object
 * 
 * @param {object} client The Redis client object used to read and write to redis 
 * @param {object} subClient The Redis client object used for pub/sub 
 * @param {string} redisKey The key to the hash in Redis 
 * @param {boolean} autoField If true, it will pull the entire value on update of key in Redis. If false, you'll need to specify directly the keys you want to observer
 */
function hyalineHash(client, subClient, redisKey, autoField) {
  var
    publicProto   = {},                                                //this will be the prototype of the final object. We can use a prototype to hide the functions and properties so the final object will be purely data
    publicObj,                                                        //This will be the final object
    shadowObj     = {},                                               //The shadowObj is used to prevent getters/setters from causing a infinite loop
    writeToShadow,
    diffHashKeys;

  publicProto.errors = new EventEmitter();                             //Errors are emitted and can be intercepted with .on(...)

  //The field method is the heart of the script - it is used internally frequently. The `fieldName` is the name of the field in question, the `initialValue` is the value that will be set (if any) and `localOnly` set to false allows for the field to NOT be set in redis
  publicProto.field = function(fieldName,initialValue,localOnly) {
    var
      setValue,
      errEvents   = this.errors;

    //set the value of a field in a hash and in the shadowHash - trigger errors if needed. 
    setValue = function(val) {
      client.hset(redisKey, fieldName, val, function(err) {
        if (err) { 
          errEvents.emit('setting', err, redisKey, fieldName, val);
          errEvents.emit('any','setting', err, redisKey, fieldName, val);
        } else {
          shadowObj[fieldName] = String(val);
        }
      });
    };
    if (!publicObj[fieldName]) {                                      //Only if the `fieldName` is not set - prevents redefining
      if (!publicObj.hasOwnProperty(fieldName)) {                     //The fieldname has not been set (preventing a situation where the `publicObj` *is* set
        Object.defineProperty(
          publicObj, 
          fieldName, 
          { 
            enumerable  : true,                                      //So it will show up in Object.keys
            set: setValue,
            get: function() {                                        //Pull it from the `shadowObject` handling both undefines and always ensuring a String output
              return shadowObj[fieldName] === undefined ? undefined : String(shadowObj[fieldName]);
            }
          }
        );
      }
      
      if (!initialValue) {                                          //If `initalValue` isn't set then we need to get it from Redis
        client.hget(redisKey,fieldName, function(err,val) {
          if (err) {                                                //Emit errors if needed
            errEvents.emit('getting', err, redisKey, fieldName, val);
            errEvenys.emit('any','getting', err, redisKey, fieldName, val);
          } else {
            shadowObj[fieldName] = String(val);                     //Finally set the shadowObj
          }
        });
      } else {                                                     
        shadowObj[fieldName] = String(initialValue);                //Set the shadowObj
        if (!localOnly) { setValue(initialValue); }                 //If we aren't wanting localOnly, then set the Value
      }
    } 
  };

  //Proto pulls the initial value of all the hash fields
  publicProto.pull = function() {
    var
      that = this,
      errEvents = that.errors;
    
    //Get all the fields from the key in question
    client.hgetall(redisKey, function(err,values) {
      if (err) {                                                //Emit errors if needed
        errEvents.emit('pulling', err, redisKey, values); 
        errEvents.emit('any','pulling', err, redisKey, values);
      } else {
        if (values) {                                           //If we have values, run through each one and make sure it is initialized and ready to go by running `.fields`
          Object.keys(values).forEach(function(aKey) {
            that.field(aKey,values[aKey],true);
          });
        }
      }
    });
  };

  //Enables all the fields in the hash to replaced at once
  publicProto.replaceWith = function(newObj) {
    var
      errEvents = this.errors;

    client
      .multi()                                                  //Make it atomic
      .del(redisKey)                                            //Out with the old
      .hmset(redisKey, newObj)                                  //In with the new
      .exec(function(err) {
        if (err) {                                              //Emit errors if needed
          errEvents.emit('replacing', err, redisKey, newObj);
        }
      });
  };

  publicObj = Object.create(publicProto);                       //Create the object with the prototype
  subClient.on('ready',function() {                             //node_redis will automatically queue up requests, but we need to get the selected_db from the object that wouldn't normally be present
    var
      db = subClient.selected_db ? subClient.selected_db : 0;  //If nothing, then it's zero
    
    publicObj.channel = ['__keyspace@'+db+'__:',redisKey].join(''); //Gotta love the funky channels - it will endup looking like '__keyspace@0__:mykey'
    subClient.subscribe(
      publicObj.channel,              
      function(err) {
        if (err) {                                             //Emit errors if needed
          publicObj.errors.emit('subscribe', err, redisKey, values);
          publicObj.errors.emit('any','subscribe', err, redisKey, values);
        }
      }
    );
  });
  
  writeToShadow = function(err,values) {
    if (err) {                                                //Emit errors if needed
      publicObj.errors.emit('syncing', err, redisKey, values);
      publicObj.errors.emit('any','syncing', err, redisKey, values);
    } else if (autoField && values) {                         //`autoField` and `values` means that we need to go through each field
      Object.keys(values).forEach(function(aKey) {
        if (shadowObj[aKey]) {                                //If it's already established, then we just set the shadowObj and go about our day
          shadowObj[aKey] = values[aKey];
        } else {                                              //If it's new then we need to register the field
          publicObj.field(aKey,values[aKey],true);
        }
      });
    } else if (values) {                                      //If not autoField then we just go through the establisehd fields and match them up with the value
      fields.forEach(function(aField,index) {
        shadowObj[aField] = values[index];
      });
    } else {                                                  //No fields, not auto, just make sure we always have an object
      shadowObj = {};
    }
  };

  diffHashKeys = function(err,keys) {
    if (err) {
        publicObj.errors.emit('del', err, redisKey);          //Emit errors if needed
    } else {
      Object.keys(shadowObj).forEach(function(aKey) {         //Go through each field
        if (keys.indexOf(aKey) === -1) {                      //If the field is present in the shadowObj but not in the field, then we need to deal with it.
          shadowObj[aKey] = undefined;
        }
      });
    }
  };

  subClient.on('message', function (channel, message) {
    var
      fields;

    if (channel === publicObj.channel) {  //only the channel we're listening to
      if (message === 'hdel') {           //handle HDEL seperately - we don't know which fields were deleted, so we need to straighten that out
        client.hkeys(
          redisKey,
          diffHashKeys
        );
      } else  {                           //all other operations are handled the same way
        if (autoField) {                  //`autoField` requires a full pull of the hash
          client.hgetall(
            redisKey,
            writeToShadow
          );
        } else {                          //Otherwise, just pull the already registered fields
          fields  = Object.keys(shadowObj);
          if (fields.length > 0) {        //in the situation where you don't have any fields registered, but you still get a message, you'll ignore it otherwise...
            client.hmget(
              redisKey,
              fields,
              writeToShadow
            );
          }
        }
      }
    }
  });

  return publicObj;
}

module.exports = hyalineHash;