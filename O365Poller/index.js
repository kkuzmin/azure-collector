/* -----------------------------------------------------------------------------
 * @copyright (C) 2018, Alert Logic, Inc
 * @doc
 *
 * The purpose of this function it to list O365 content periodically using
 * 'subscriptions/content' operation and publish content events into
 * a storage queue.
 *
 * @end
 * -----------------------------------------------------------------------------
 */
 
const async = require('async');

const m_o365mgmnt = require('../lib/o365_mgmnt');
const m_state = require('./liststate');

const PAGES_COUNT = 5;

var processStream = function(stream, listState, callback) {
    m_o365mgmnt.subscriptionsContent(
        stream, listState.listStartTs, null,
        function(listError, listResult, httpRequest, response) {
            return processListResponse(listError, 
                listResult,
                httpRequest,
                response,
                PAGES_COUNT,
                callback 
            );
    });
};

var processListResponse = function(listError,
        listResult, httpRequest, response, pageCount, callback) {
    if (listError) {
        return callback(listError);
    } else {
        if (pageCount > 0 && response.headers.nextpageuri) {
            m_o365mgmnt.getContent(response.headers.nextpageuri, 
                function(getError, newResult, newHttpRequest, newResponse) {
                    return processListResponse(getError, 
                            listResult.concat(newResult),
                            newHttpRequest,
                            newResponse,
                            pageCount - 1,
                            callback);
            });
        } else {
            return callback(null, listResult);
        }
    }
};

var fillOutputQueues = function(context, timer, contentResults) {
    // Put content notifications into output binding queue.
    context.bindings.O365ContentMsg = [];
    for (var i = 0; i < contentResults.length; i++)
    {
        var streamContent = contentResults[i];
        context.log.info('Content length:', streamContent.streamName, streamContent.contentList.length);
        for (var j = 0; j < streamContent.contentList.length; j++)
        {
            context.bindings.O365ContentMsg.push(streamContent.contentList[j]);
        }
    }
    
    var newCollectState = m_state.getCollectState(timer, contentResults);
    context.bindings.O365ListState = [];
    context.bindings.O365ListState.push(JSON.stringify(newCollectState));
    
    return context;
};

module.exports = function (context, AlertlogicO365ListTimer) {
    m_state.fetch(function(stateErr, currentState, stateMsg) {
        if (stateErr) {
            context.log.info('Singleton protection.');
            context.done();
        } else {
            async.map(['Audit.General', 'Audit.AzureActiveDirectory'], 
                function(stream, asyncCallback) {
                    var streamListState = m_state.getStreamListState(stream, currentState);
                    context.log.info('Listing content:', streamListState);
                    processStream(stream, streamListState, function(listErr, listResult) {
                        if (listErr) {
                            return asyncCallback(listErr);
                        } else {
                            var result = {
                                streamName : stream,
                                contentList : listResult
                            };
                            return asyncCallback(null, result);
                        }
                        
                    });
                },
                function(mapError, mapResult) {
                    if (mapError) {
                        context.done(mapError);
                    } else {
                        var resultContext = fillOutputQueues(context, AlertlogicO365ListTimer, mapResult);
                        m_state.commit(stateMsg, function(commitErr){
                            if (commitErr) {
                                resultContext.log.error(`Recollection is likely to happen $currentState.`);
                                resultContext.done(commitErr);
                            } else {
                                resultContext.log.info('Publishing notifications done.');
                                resultContext.done();
                            }
                        });
                    }
            });
        }
    });
};
