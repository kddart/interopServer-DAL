// -*- mode: js; js-indent-level: 4; js-curly-indent-offset: 4; -*-
//
// dalclient library - provides utilities to assist in using KDDart-DAL servers
// Copyright (C) 2015  Diversity Arrays Technology
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.
//
// dal-client.js
// Reference implementation to parallel the Java DALClient

// ================================================================
// Dependencies:
//    lodash.js (preferred) or underscore.js
//    sha1.js
//    jquery.js
//
// ================================================================

// Methods available:
// ==================
// getBaseUrl()

// getUserId()
// getGroupId()
// getGroupName()
// getWriteToken()
// getResponseType() : "XML" or "JSON"
// isInAdminGroup()  : true/false

// isLoggedIn()      : true/false

// setBaseUrl(url)
// setExplicitLogout(boolean)
// setResponseType("XML" or "JSON")

// logout()

// login(username, password, callback)
//    callback: function(dalResponse)

// switchGroup(groupId, callback)
//    callback: function(dalResponse)

// performQuery(queryOperation, callback, optionalParams)
//    callback: function(dalResponse)
//    optionalParams: if non-null must be a 'json' object

// performUpdate(updateOperation, postParams, callback)
//    updateOperation: string
//    postParams:      object
//    callback:        function(dalResponse)

// performUpload(uploadOperation, postParams, filecontent, callback)
//    uploadOperation: string
//    postParams:      object
//    filecontent:     string
//    callback:        function(dalResponse)

// ===================================================================
// Manifest constants and utility functions useful in DAL interactions

var DALUtil = {

	// These events are published by the client on login state transitions
	EVENT_CLIENT_LOGGED_IN: "DALClient-logged-in",
	EVENT_CLIENT_LOGGED_OUT: "DALClient-logged-out",

	ERRMSG_ALREADY_LOGGED_IN: "Already logged in", // Message from DALClient when userId>=0

	ERRMSG_ALREADY_LOGIN: "Already login.", // "Error" message from DAL when already logged in

	TAG_RECORD_META: "RecordMeta",  // most responses with data
	ATTR_TAG_NAME: "TagName",       // says which other tags are present

	TAG_ERROR: "Error",
	ATTR_MESSAGE: "Message",

	TAG_USER: "User",               // login
	ATTR_USER_ID: "UserId",

	TAG_WRITE_TOKEN: "WriteToken",  // login
	ATTR_VALUE: "Value",            // also available from TAG_INFO

	TAG_INFO: "Info",
	ATTR_VERSION: "Version",      // get/version
	ATTR_GROUP_NAME: "GroupName", // switch/group
	ATTR_GADMIN: "GAdmin",        // switch/group

	TAG_SYSTEM_GROUP: "SystemGroup",       // list/group
	ATTR_SYSTEM_GROUP_ID: "SystemGroupId",
	ATTR_SYSTEM_GROUP_NAME: "SystemGroupName",

	TAG_OPERATION: "Operation", // list/operation
	ATTR_REST: "Rest",

	TAG_PAGINATION: "Pagination",  // list/ENTITY/_nperpage/page/_num
	ATTR_NUM_OF_RECORDS: "NumOfRecords",
	ATTR_NUM_OF_PAGES: "NumOfPages",
	ATTR_PAGE: "Page",
	ATTR_NUM_PER_PAGE: "NumPerPage",

	// add/... returns:
	//  TAG_RETURN_ID
	//      ATTR_VALUE=<value of new primary key>
	//      PARANAME=<primary key column name>


	TAG_RETURN_ID: "ReturnId",     // add/... update/... and upload/...  may return this
	ATTR_PARA_NAME: "ParaName", // from add/... with the primary key name?


	TAG_RETURN_ID_FILE: "ReturnIdFile", // from upload/...
	ATTR_XML: "xml",			// from upload/...

	_entityMap: {
		"=": '&#x3d;',
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		'"': '&quot;',
		"'": '&#x27;',
		"/": '&#x2F;'
	},

	escapeHtml: function(string) {
		return String(string).replace(/[=&<>"'\/]/g, function (s) {
			return _entityMap[s];
		});
	},

	// Generate a random number and return it as a string
	generateRandomNumber: function() {
		var digits = "0123456789";
		var s = "";
		var zero = true;
		for (var i = 0; i < 12; ++i) {
			var index = Math.floor(Math.random() * 10);
			if (! zero || index!=0) {
				zero = false;
				s += digits.substring(index, index+1);
			}
		}
		return s;
	},

	extractErrorMessage: function(rowdata) {
		var tmp = rowdata[DALUtil.TAG_ERROR];
		var msg = tmp[DALUtil.ATTR_MESSAGE];
		return msg;
	},

	// "yyyy-MM-dd HH:mm:ss" appears to be the format supported by the DAL
	getNow: function() {
		var twodig = function(n) {
			return (n<10) ? ("0"+n) : (""+n);
		};
		var dt = new Date();
		var ts = dt.getFullYear()+"-"+twodig(dt.getMonth()+1)+"-"+twodig(dt.getDate())+" "+
		twodig(dt.getHours())+":"+twodig(dt.getMinutes())+":"+twodig(dt.getSeconds());
		return ts;
	}
};


// ================================================================
// 0.2.1: the demo code uses a generic response handler and some
//        DAL responses do not have a RecordMeta tag so that
//        the call to XxxDalResponse.visitResults() with no tagNames
//        parameter doesn't know what to visit.
//        Cater for this by constructing an array of all the top-level
//        tags in the Json or Xml response and using those instead.
//        
function DALClient() {
	
	var VERSION = "0.2.1";
	this.getDALClientVersion = function() {
		return "DALClient-v"+VERSION;
	};

	var NOT_LOGGED_IN_USERID = -2;
	var UNKNOWN_USERID = -1;
	var RESPONSE_ERROR = false;

	// We don't allow perform(Query|Update|Upload) to accept
	// these operations because that wouldn't let us track the state changes
	// we need to maintain the correct _clientState

	var LOGIN_PREFIX = "login/";
	var LOGOUT_COMMAND = "logout";
	var SWITCH_GROUP_PREFIX = "switch/group/";

	// provide a function to call just $.ajax() is invoked
	// Note that this function *may* modify the parameters if it wishes to.
	var _beforeAjaxCall = null;
	this.setBeforeAjaxCall = function(f) {
		if (typeof f==="function") {
			_beforeAjaxCall = f;
		}
	};

	// For a successful ajax call, the parameters will be:
	//    data, textStatus, jqXHR
	// whereas for an unsuccessful call, the parameters will be:
	//    jqXHR, textStatus, errorThrown
	// which follows the functionality of the jQuery.ajax function.
	var _afterAjaxCall = null;
	this.setAfterAjaxCall = function(f) {
		if (typeof f==="function") {
			_afterAjaxCall = f;
		}
	};

	var _clientState = {
		baseUrl: null,

		userId: NOT_LOGGED_IN_USERID,
		groupId: -1,   // current group id - changed by login or switchGroup
		groupName: null, // current group name
		isInAdminGroup: null, // unknown at this stage

		//	switchGroupOnLogin: true,
		writeToken: null,
		jsonResponseType: true,
		explicitLogout: false
	};


	var _isLoggedIn = function() {
		return _clientState.userId!=NOT_LOGGED_IN_USERID;
	};

	this.isLoggedIn = _isLoggedIn;

	this.getBaseUrl = function() {
		return _clientState.baseUrl;
	};

	this.getUserId = function() {
		if (_clientState.userId<0) {
			return null;
		}
		return _clientState.userId;
	};

	this.getGroupId = function() {
		return _clientState.groupId;
	};

	this.getGroupName = function() {
		return _clientState.groupName;
	}

	//    this.getSwitchGroupOnLogin = function() {
	//	return _clientState.switchGroupOnLogin;
	//    };

	this.getWriteToken = function() {
		return _clientState.writeToken;
	}

	// returns JSON or XML
	this.getResponseType = function() {
		return _clientState.jsonResponseType ? "JSON" : "XML";
	}

	this.isInAdminGroup = function() {
		return _clientState.isInAdminGroup;
	};

	this.setBaseUrl = function(url) {
		if (url.substring(url.length-1)=="/") {
			_clientState.baseUrl = url + ""; // force copy
		}
		else {
			_clientState.baseUrl = url + "/";
		}
	};

	this.setExplicitLogout = function(yesNo) {
		_clientState.explicitLogout = yesNo;
	};

	//    this.setSwitchGroupOnLogin = function(yesNo) {
	//	_clientState.switchGroupOnLogin = yesNo;
	//    };

	// XML or JSON
	this.setResponseType = function(rtype) {
		if (rtype=="XML" || rtype=="xml") {
			_clientState.jsonResponseType = false;
		}
		else if (rtype=="JSON" || rtype=="json") {
			_clientState.jsonResponseType = true;
		}
		else {
			throw "Invalid responseType: '"+rtype+"'";
		}
	};


	var _buildDalSuccessResponse = function(ajaxParams, jqxhr, textStatus, data, cb) {

		var httpStatusCode = jqxhr.status;

		var response;
		if (ajaxParams.dataType=="xml") {
			// TODO check if the responseText/data is correct
			response = new XmlDalResponse(ajaxParams.url,
						      httpStatusCode, null /*no error*/,
						      jqxhr.responseText,
						      data);
		}
		else {
			// TODO check if the responseText/data is correct
			response = new JsonDalResponse(ajaxParams.url,
						       httpStatusCode, null /*no error*/,
						       jqxhr.responseText,
						       data);
		}

		cb(response);
	};

	var _makeJsonError = function(message) {
		var tagError = {};
		tagError[DALUtil.ATTR_MESSAGE] = message;

		var json = {};
		json[DALUtil.TAG_ERROR] = [ tagError ];
		return json;
	};

	var _makeXmlError = function(message) {
		var s = "<DATA>";
		s += "<"+DALUtil.TAG_ERROR+" "+DALUtil.ATTR_MESSAGE+"='"+message+"'/>";
		s += "</DATA>";
		return $.parseXML(s);
	};

	var _buildXmlDalErrorResponse = function(ajaxParams, jqxhr, textStatus, errorThrown) {

		var httpStatusCode = jqxhr.status;
		var httpErrorReason = jqxhr.statusText;

		var xml;

		if (jqxhr.responseText=="") {
			if (httpStatusCode==0 && httpErrorReason=="error") {
				xml = _makeXmlError("HTTP Error:"+
						    " code="+httpStatusCode+
						    " reason="+DALUtil.escapeHtml(httpErrorReason)+
						    " (possibly incorrect URL)");
			}
			else {
				xml = _makeXmlError("HTTP Error:"+
						    " code="+httpStatusCode+
						    " reason="+DALUtil.escapeHtml(httpErrorReason));
			}
		}
		else {
			try {
				// A '404 - page not found' may have valid "xml" in the responseText
				// so guard against using it for the xml content.
				if (httpStatusCode == 420 || (httpStatusCode >= 200 && httpStatusCode < 300)) {
					// The error message is in the responseText
					xml = $.parseXML(jqxhr.responseText);
				}
				else {
					xml = _makeXmlError("HTTP Error:"+
							    " code="+httpStatusCode+
							    " reason="+DALUtil.escapeHtml(httpErrorReason));
				}
			}
			catch (err) {
				// TODO wrap htmlEscape around reason
				xml = _makeXmlError("HTTP Error:"+
						    " code="+httpStatusCode+
						    " reason="+DALUtil.escapeHtml(httpErrorReason));
			}
		}

		return new XmlDalResponse(ajaxParams.url,
					  httpStatusCode, httpErrorReason,
					  jqxhr.responseText,
					  xml);
	};

	var _buildJsonDalErrorResponse = function(ajaxParams, jqxhr, textStatus, errorThrown) {

		var httpStatusCode = jqxhr.status;
		var httpErrorReason = jqxhr.statusText;

		var json = null;

		if (jqxhr.responseText=="") {
			json = _makeJsonError("HTTP Error:"+
					      " code="+httpStatusCode+
					      " reason="+httpErrorReason+
					      " (possibly incorrect URL)");
		}
		else {
			try {
				json = $.parseJSON(jqxhr.responseText);
			}
			catch (err) {
				if (jqxhr.responseText.indexOf("<?xml ")==0) {
					// This is a problem with the DAL not respecting the
					// ctype=json request from the client.
					// We'll try to get it from the XML...

					try {
						var xmldoc = $.parseXML(jqxhr.responseText);
						var $xml = $(xmldoc);
						var records = $xml.find(DALUtil.TAG_ERROR);
						if (records && records.length>0) {
							var msg = $(records[0]).attr(DALUtil.ATTR_MESSAGE);
							if (msg==null) {
								// It must be in that "weird format"
								$.each(records[0].attributes,function(){
									if (msg==null) {
										msg = this.name+":"+this.value;
									}
									else {
										msg += " "+this.name+":"+this.value;
									}
								});
							}
							json = _makeJsonError(msg);
						}
						else if ("Not Found"==httpErrorReason) {
							json = _makeJsonError("HTTP Error:"+
									      " code="+httpStatusCode+
									      " reason="+httpErrorReason+
									      " (possibly incorrect URL)");
						}
						else {
							json = _makeJsonError("HTTP Error:"+
									      " code="+httpStatusCode+
									      " reason="+httpErrorReason+
									      " response="+jqxhr.responseText);
						}
					}
					catch (err2) {
						// bummer ... can't even use that!
						console.log("Invalid XML: "+jqxhr.responseText);
						json = _makeJsonError("invalid XML in responseText");
					}
				}
				else {
					console.log("Invalid JSON: "+jqxhr.responseText);
					json = _makeJsonError("invalid JSON in responseText");
				}
			}
		}

		return new JsonDalResponse(ajaxParams.url,
					   httpStatusCode, httpErrorReason,
					   jqxhr.responseText,
					   json);
	};

	var _convertXmlNodeToJson = function(node) {

		var result = {};

		var children = node.children();
		if (children!=null && children.length>0) {
			$.each(children,
			       function(index, node) {
				       var nodeObject = {};
				       $.each(node.attributes,
					      function() {
						      nodeObject[this.name] = this.value;
					      });

				       var list = result[node.tagName];
				       if (list==null) {
					       list = [];
					       result[node.tagName] = list;
				       }
				       list.push(nodeObject);
				       //		   if (node.children.length>0) {
				       //   ?? multi-level?
				       //		   }
			       });
		}
		return result;
	}

	// This is to support the work-around when the DAL responds with XML content
	// for a DAL operation but we have requested JSON as the output.
	var _convertDalXmlToJson = function(xmltext) {
		var result = null;

		var xmldoc = $.parseXML(xmltext);
		var $xml = $(xmldoc);
		var root = $xml.find("DATA");
		if (root!=null) {
			return _convertXmlNodeToJson(root);
		}
		return result;
	};

	var _buildDalErrorResponse = function(ajaxParams, jqxhr, textStatus, errorThrown, cb) {

		var httpStatusCode = jqxhr.status;
		var httpErrorReason = jqxhr.statusText;

		var response = null;
		if (ajaxParams.dataType=="xml") {
			response = _buildXmlDalErrorResponse(ajaxParams, jqxhr, textStatus, errorThrown);
		}
		else {
			if (httpStatusCode==200) { // && "syntaxError"==errorThrown) {
				// Bugger - this may be the DAL not behaving correctly
				if (jqxhr.responseText.indexOf("<?xml ")==0) {
					// Yup. that's probably it!
					var data = _convertDalXmlToJson(jqxhr.responseText);
					var dataAsJSON = JSON.stringify(data); // fake out responseText
					response = new JsonDalResponse(ajaxParams.url,
								       httpStatusCode, null /*no error*/,
								       dataAsJSON,
								       data);
				}
			}
			if (response==null) {
				response = _buildJsonDalErrorResponse(ajaxParams, jqxhr, textStatus, errorThrown);
			}
		}

		cb(response);
	};


	var _doAjaxCall = function(ajaxParams, success, failure) {

		var successFunction = function(aparams, cb) {
			return function(data, textStatus, jqxhr) {
				_buildDalSuccessResponse(aparams, jqxhr, textStatus, data, cb);
			}
		}(ajaxParams, success);

		var errorFunction = function(aparams, cb) {
			return function(jqxhr, textStatus, errorThrown) {
				_buildDalErrorResponse(aparams, jqxhr, textStatus, errorThrown, cb);
			};
		}(ajaxParams, failure);


		console.log("[dal-client: "+ajaxParams.type+" "+ajaxParams.url+"]");

		if (_beforeAjaxCall!=null) {
			_beforeAjaxCall(ajaxParams);
		}

		$.ajax(ajaxParams)
		.done(successFunction)
		.fail(errorFunction)
		.always(_afterAjaxCall);
	};

	// Note that params is optional and may be swapped with callback
	// to allow improved code readability
	var _performQuery = function(qry, needToCheck, callback, ajaxData) {

		if (typeof ajaxData=="function") {
			// supplied and swapped !
			var tmp = callback;
			callback = ajaxData;
			ajaxData = tmp;
		}

		if (_clientState.baseUrl==null) {
			var errmsg = "DALClient.setBaseUrl() has not yet been called";
			var errorResponse = new ErrorDalResponse(url, "200", errmsg, errmsg);
			setTimeout(function(){callback(errorResponse);}, 500);
			return;
		}

		var url = _clientState.baseUrl + qry;

		if (needToCheck && _commandNotAllowed("performQuery()", qry, url, callback)) {
			// callback has been scheduled
			return;
		}

		if (_clientState.jsonResponseType) {
			url = url + ((url.indexOf("?")<0) ? "?ctype=json" : "&ctype=json");
		}

		var ajaxParams = {
			type: "GET",
			url: url,
			//crossDomain: false,
			xhrFields: { withCredentials: true },
			dataType: (_clientState.jsonResponseType ? "json" : "xml")
		};

		if (typeof ajaxData=="object") {
			ajaxParams["data"] = ajaxData;
		}

		_doAjaxCall(ajaxParams, callback, callback);
	};

	this.logout = function() {
		_performQuery(LOGOUT_COMMAND, false, function(response){/*do nothing*/});
		// Assume it worked

		var changed = _isLoggedIn();

		_clientState.userId = NOT_LOGGED_IN_USERID;
		_clientState.writeToken = null;

		_clientState.groupId = -1;
		_clientState.groupName = null;
		_clientState.isInAdminGroup = null;

		if (changed) {
			$.publish(DALUtil.EVENT_CLIENT_LOGGED_OUT);
		}
	};

	var _giveErrorResponse = function(url, callback, errmsg) {
		var errorResponse = new ErrorDalResponse(url, "200", errmsg, errmsg);
		setTimeout(function(){callback(errorResponse);}, 500);
	};

	this.login = function(username, password, callback) {

		if (_clientState.userId >= 0) {
			_giveErrorResponse(LOGIN_PREFIX, callback, DALUtil.ERRMSG_ALREADY_LOGGED_IN);
			return;
		}

		if (_clientState.baseUrl==null) {
			_giveErrorResponse(LOGIN_PREFIX, callback, "DALClient.setBaseUrl() has not yet been called");
			return;
		}

		var url = _clientState.baseUrl +
		LOGIN_PREFIX+username+"/"+(_clientState.explicitLogout ? "yes" : "no");

		var rand = DALUtil.generateRandomNumber();

		var pwdUnameHash = hex_hmac_sha1(password, username);
		var randhash     = hex_hmac_sha1(pwdUnameHash, rand);
		var signature    = hex_hmac_sha1(randhash, url);

		var postParams = {
			rand_num: rand,
			url: url,
			signature: signature
		};

		if (_clientState.jsonResponseType) {
			postParams["ctype"] = "json";
		}

		var ajaxParams = {
			type: "POST",
			url: url,
			//crossDomain: false,
			xhrFields: { withCredentials: true },
			data: postParams,
			dataType: (_clientState.jsonResponseType ? "json" : "xml")
		};

		var successCallback = function(cb) {
			return function(response) {
				if (null==response.getResponseErrorMessage()) {

					_clientState.userId = response.getRecordFieldValue(
					    DALUtil.TAG_USER, DALUtil.ATTR_USER_ID);

					_clientState.writeToken = response.getRecordFieldValue(
					    DALUtil.TAG_WRITE_TOKEN, DALUtil.ATTR_VALUE);

					_clientState.groupId = -1; // still need to do switchGroup...
					_clientState.groupName = "Unknown";
					_clientState.isInAdminGroup = null;// basically, we don't know but this is "falsy"

					$.publish(DALUtil.EVENT_CLIENT_LOGGED_IN);

				}
				cb(response);
			};
		}(callback);

		var errorCallback = function(cb) {
			return function(response) {
				var errmsg = response.getResponseErrorMessage();
				if (errmsg==DALUtil.ERRMSG_ALREADY_LOGIN) {
					// Oops. Oh well, do the best we can...
					_clientState.userId = UNKNOWN_USERID;
					_clientState.writeToken = "already-logged-in";

					_clientState.groupId = -1;
					_clientState.groupName = "Unknown";
					_clientState.isInAdminGroup = null;// basically, we don't know but this is "falsy"
				}
				cb(response);
			};
		}(callback);

		_doAjaxCall(ajaxParams, successCallback, errorCallback);
	}; // login

	this.switchGroup = function(groupId, callback) {
		var myCallback = function(cb, gid) {
			return function(response) {
				if (null==response.getResponseErrorMessage()) {
					var rowdata = response.getFirstRecord(DALUtil.TAG_INFO);
					_clientState.groupId = gid;
					_clientState.groupName = rowdata[DALUtil.ATTR_GROUP_NAME];
					_clientState.isInAdminGroup = "TRUE"==rowdata[DALUtil.ATTR_GADMIN];
				}
				cb(response);
			}
		}(callback, groupId);

		return _performQuery(SWITCH_GROUP_PREFIX + groupId, false, myCallback);
	};

	var _commandNotAllowed = function(callersName, qry, url, callback) {
		var errorResponse = null;
		if (qry.indexOf(LOGIN_PREFIX)==0) {
			errorResponse = new ErrorDalResponse(url,
							     "200", "Invalid for "+callersName+": "+qry,
							     "Command not allowed: "+qry);
		}
		else if (qry.indexOf(LOGOUT_COMMAND)==0) {
			errorResponse = new ErrorDalResponse(url,
							     "200", "Invalid for "+callersName+": "+qry,
							     "Command not allowed: "+qry);
		}
		else if (qry.indexOf(SWITCH_GROUP_PREFIX)==0) {
			errorResponse = new ErrorDalResponse(url,
							     "200", "Invalid for "+callersName+": "+qry,
							     "Command not allowed: "+qry);
		}

		if (errorResponse!=null) {
			setTimeout(function(){callback(errorResponse);}, 500);
		}

		return errorResponse!=null;
	};

	this.performQuery = function(qry, callback, optionalAjaxData) {
		return _performQuery(qry, true, callback, optionalAjaxData);
	};

	var _collectUpdateParams = function(url, postParams) {

		var namesInOrder = [];

		var rand_num = DALUtil.generateRandomNumber();

		var forSignature = url + rand_num;

		// genusId = 762
		// rand_num = 4751791882182541196

		_.each(postParams,
		       function(value, key) {
			       namesInOrder.push(key);
			       if (value!=null) {
				       forSignature += value;
			       }
		       });

		//                                                        |                  |
		// https://kddart.diversityarrays.com/dal/update/genus/7624751791882182541196GENUS_changed

		var signature = hex_hmac_sha1(_clientState.writeToken, forSignature);
		// 9c9c0420e0741a9ab61de14fae55f6bfb4eb96a4
		// namesInOrder: GenusName,

		var forPost = {};
		_.extend(forPost, postParams);

		forPost["rand_num"]    = rand_num;
		forPost["url"]         = url;
		forPost["param_order"] = namesInOrder.join(",");
		forPost["signature"]   = signature;

		if (_clientState.jsonResponseType) {
			forPost["ctype"] = "json";
		}

		return forPost;
	};

	this.performUpdate = function(command, postParams, callback) {
		if (_commandNotAllowed("performUpdate()", command, url, callback)) {
			// callback already scheduled
			return;
		}

		if (_clientState.baseUrl==null) {
			_giveErrorResponse(command, callback, "DALClient.setBaseUrl() has not yet been called");
			return;
		}

		var url = _clientState.baseUrl + command;

		var updateParams = _collectUpdateParams(url, postParams);

		var ajaxParams = {
			type: "POST",
			url: url,
			//crossDomain: false,
			data: updateParams,
			xhrFields: { withCredentials: true },
			dataType: (_clientState.jsonResponseType ? "json" : "xml")
		};

		_doAjaxCall(ajaxParams, callback, callback);
	};

	this.performUpload = function(command, postParams, filecontent, callback) {

		if (_commandNotAllowed("performUpload()", qry, url, callback)) {
			// callback already scheduled
			return;
		}

		if (_clientState.baseUrl==null) {
			_giveErrorResponse(command, callback, "DALClient.setBaseUrl() has not yet been called");
			return;
		}

		_giveErrorResponse(command, callback, "Not yet implemented: performUpload()");
	};
}

// ================================================================
// DalResponse implementations
// ================================================================

// getUrl()                  string
// getHttpStatusCode()       integer
// getHttpErrorReason()      null or string
// getResponseText()         string

// getResponseIsDTD()        true/false

// getFirstRecord(tagname)   return json map
// getResponseErrorMessage() null if not error
// getRecordMetaTagNames()   returns array of strings

// visitResults(visitor, tagNamesArray)
//   visitor:       function(tagname, rowdata)
//                  when: tagname==null, rowdata { TAG_ERROR: errormessage }
//                        typeof tagname=="string", rowdata is a 'json' object
//
//   tagNamesArray: if null or empty, use all RecordMeta/TagName values
//                  if a string, only process that one
//                  else only process the ones provided


var asDalResponse = function() {
	this.getUrl = function() {
		return this.url;
	};
	this.getHttpStatusCode = function() {
		return this.httpStatusCode;
	};
	this.getHttpErrorReason = function() {
		return this.httpErrorReason;
	};
	this.getResponseText = function() {
		return this.responseText;
	};
	this.getResponseIsDTD = function() {
		return this.responseText!=null && this.responseText.indexOf("<!")==0;
	};
	this.getRecordFieldValue = function(tagname, attrname) {
		var rowdata = this.getFirstRecord(tagname);
		return rowdata[attrname];
	};

	// result.visitor  is always the function
	// result.tagNames is always an array (possibly empty)
	this._normaliseVisitResultsParams = function(visitor, tagNameOrNames) {
		var result = {}
		if (tagNameOrNames==null) {
			// assume visitor is the function
			result.visitor = visitor;
			result.tagNames = [];
		}
		else if (typeof tagNameOrNames=="string") {
			// assume visitor is the function
			result.visitor = visitor;
			result.tagNames = [ tagNameOrNames ];
		}
		else if (_.isArray(tagNameOrNames)) {
			// assume visitor is the function
			result.visitor = visitor;
			result.tagNames = tagNameOrNames;
		}
		else if (typeof tagNameOrNames=="function") {
			// Assume user got them the wrong way around
			result.visitor = tagNameOrNames;
			if (typeof visitor=="string") {
				result.tagNames = [ visitor ];
			}
			else if (_.isArray(visitor)) {
				result.tagNames = visitor;
			}
			else {
				throw "Illegal arguments to visitResults";
			}
		}
		else {
			throw "Illegal arguments to visitResults";
		}
		return result;
	};

	this.visitError = function(visitor, errmsg) {
		var err = (errmsg!=null) ? errmsg : this.getResponseErrorMessage();
		var json = _makeJsonError(err);
		// NOTE: 'null' means this is the error call
		visitor( null, json );
		return false;
	};
};

// - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

function ErrorDalResponse(url, statusCode, errorReason, errmsg) {
	this.url = url;
	this.httpStatusCode = statusCode;
	this.httpErrorReason = errorReason;
	this.responseText = errorReason;
	this.responseErrorMessage = errmsg;
}

asDalResponse.call(ErrorDalResponse.prototype);

ErrorDalResponse.prototype.getResponseErrorMessage = function() {
	return this.responseErrorMessage;
};

ErrorDalResponse.prototype.getFirstRecord = function(tagname) {
	var result = {};
	if (tagname==DALUtil.TAG_ERROR) {
		result[DALUtil.ATTR_MESSAGE] = this.responseErrorMessage;
	}
	return result;
};

ErrorDalResponse.prototype.visitResults = function(visitor, tagNamesArray) {
	var params = this._normaliseVisitResultsParams(visitor, tagNamesArray);
	return this.visitError(params.visitor);
};

ErrorDalResponse.prototype.getResults = function(tagname) {
	var result = [];
	if (tagname==DALUtil.TAG_ERROR) {
		var tmp = {};
		tmp[DALUtil.TAG_ERROR] = this.responseErrorMessage;
		result.push(tmp);
	}
	return result;
};

// - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

function XmlDalResponse(url, statusCode, errorReason, text, xmldoc) {
	this.url = url;
	this.httpStatusCode = statusCode;
	this.httpErrorReason = errorReason;
	this.responseText = text;
	this.xmldoc = xmldoc;

	this.$xml = null;
}

asDalResponse.call(XmlDalResponse.prototype);

// - - - - - - -

// Intended for internal use only
XmlDalResponse.prototype._getXmlDoc = function() {
	if (this.$xml==null) {
		this.$xml = $(this.xmldoc);
	}
	return this.$xml;
};

// Return a JSON representation of the first record for the tagname
XmlDalResponse.prototype.getFirstRecord = function(tagname) {

	var result = {};

	var $xml = this._getXmlDoc();

	var records = $xml.find(tagname);
	if (records && records.length>0) {
		result = this._asRowdata(records[0]);
		//	$.each(records[0].attributes, function() { result[this.name] = this.value; });
	}

	return result;
};

XmlDalResponse.prototype.getResponseErrorMessage = function() {

	var $xml = this._getXmlDoc();

	var errorParts = [];

	$xml.find(DALUtil.TAG_ERROR).each(function() {
		$.each(this.attributes,
		       function() {
			       if (this.name==DALUtil.ATTR_MESSAGE) {
				       errorParts.push(this.value);
			       }
			       else {
				       errorParts.push(this.name+":"+this.value);
			       }
		       });
	});

	return errorParts.length<=0 ? null : errorParts.join(", ");
};

XmlDalResponse.prototype._asRowdata = function($xmlnode) {
	var rowdata = {};
	$.each($xmlnode.attributes,
	       function() {
		       rowdata[this.name] = this.value;
	       });
	return rowdata;
};

XmlDalResponse.prototype.getRecordMetaTagNames = function(fakeIt) {

	var $xml = this._getXmlDoc();

	var tagNames = [];
	$xml.find(DALUtil.TAG_RECORD_META).each(function(a,b) {
		var tagName = $(this).attr(DALUtil.ATTR_TAG_NAME);
		if (typeof tagName=="string") {
			tagNames.push(tagName);
		}
	});
	if ((tagNames.length<=0) && fakeIt) {
		$xml.find("DATA").children().each(function(a,b){
			tagNames.push(b.tagName);
		});
	}
	return tagNames;
};

XmlDalResponse.prototype.visitResults = function(visitor, tagNamesArray) {

	var params = this._normaliseVisitResultsParams(visitor, tagNamesArray);

	var errmsg = this.getResponseErrorMessage();
	if (errmsg!=null) {
		return this.visitError(params.visitor, errmsg);
	}

	var tagNames = params.tagNames;
	if (tagNames.length<=0) {
		tagNames = this.getRecordMetaTagNames(true);
	}

	var $xml = this._getXmlDoc();

	var nTagNames = tagNames.length
	for (var ti = 0; ti < nTagNames; ++ti) {
		var tagName = tagNames[ti];
		var records = $xml.find(tagName);
		var nRecords = records.length;
		for (var ri = 0; ri < nRecords; ++ri) {
			var rowdata = this._asRowdata(records[ri]);
			if (! visitor(tagName, rowdata )) {
				return false;
			}
		}
	}
	return true;
};


XmlDalResponse.prototype.getResults = function(tagname) {
	var $xml = this._getXmlDoc();
	var records = $xml.find(tagname);
	var nRecords = records.length;
	var result = [];
	for (var ri = 0; ri < nRecords; ++ri) {
		var rowdata = this._asRowdata(records[ri]);
		result.push(rowdata);
	}
	return result;
};


// - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

function JsonDalResponse(url, statusCode, errorReason, text, json) {
	this.url = url;
	this.httpStatusCode = statusCode;
	this.httpErrorReason = errorReason;
	this.responseText = text;
	this.json = json;
}

asDalResponse.call(JsonDalResponse.prototype);

// - - - - - - -

// Return the first JSON record for the tagname
JsonDalResponse.prototype.getFirstRecord = function(tagname) {

	var records = this.json[tagname];

	var result;
	if (_.isArray(records) && records.length>0) {
		result = records[0];
	}
	else {
		result = {};
	}
	return result;
};

JsonDalResponse.prototype.getResponseErrorMessage = function() {

	var errorTags = this.json[DALUtil.TAG_ERROR]

	if (! _.isArray(errorTags)) {
		return null;
	}

	var errorParts = [];
	$.each(errorTags, function() {
		var err = this;
		for (var name in err) {
			if (err.hasOwnProperty(name)) {
				if (name==DALUtil.ATTR_MESSAGE) {
					errorParts.push(err[name]);
				}
				else {
					errorParts.push(name+":"+err[name]);
				}
			}
		}
	});

	return errorParts.length<=0 ? "Error without message!" : errorParts.join(", ");
};

JsonDalResponse.prototype.getRecordMetaTagNames = function(fakeIt) {
	var tagNames = [];

	var rmetas = this.json[DALUtil.TAG_RECORD_META];
	if (_.isArray(rmetas)) {
		_.each(rmetas, function(meta) {
			var tagName = meta[DALUtil.ATTR_TAG_NAME];
			if (typeof tagName=="string") {
				tagNames.push(tagName);
			}
		});
	}
	else if (fakeIt) {
		for (var tag in this.json) {
			if (this.json.hasOwnProperty(tag)) {
				tagNames.push(tag);
			}
		}
	}
	return tagNames;
};


// visitor(result)
// where result == { error: errmsg-or-null; data: { name: value, ... } }

JsonDalResponse.prototype.visitResults = function(visitor, tagNamesArray) {

	var params = this._normaliseVisitResultsParams(visitor, tagNamesArray);

	var errmsg = this.getResponseErrorMessage();
	if (errmsg!=null) {
		return this.visitError(params.visitor, errmsg);
	}

	var tagNames = params.tagNames;
	if (tagNames.length<=0) {
		tagNames = this.getRecordMetaTagNames(true);
	}

	var nTagNames = tagNames.length
	for (var ti = 0; ti < nTagNames; ++ti) {
		var tagName = tagNames[ti];

		var records = this.json[tagName];
		var nRecords = 0;
		if (_.isArray(records)) {
			nRecords = records.length;
		}
		for (var ri = 0; ri < nRecords; ++ri) {
			var rowdata = records[ri];
			if (! params.visitor(tagName, rowdata)) {
				return false;
			}
		}
	}
	return true;
};


JsonDalResponse.prototype.getResults = function(tagname) {
	var result = this.json[tagname];
	if (! _.isArray(result)) {
		result = [];
	}
	return result;
};
