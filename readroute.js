const { ObjectId } = require("bson");

const SUPPORTED_QUERY_OPERATORS = new Set([
    "eq",
    "ne",
    "gt",
    "gte",
    "lt",
    "lte",
    "in",
    "nin",
    "exists",
]);

function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function validateFieldPath(path) {
    if (typeof path !== "string" || !/^[A-Za-z0-9_.]+$/.test(path)) {
        throw new TypeError("Invalid filter field path");
    }
    return path;
}

function parseFilterValue(value) {
    let normalizedValue = String(value);
    let betweenMatch = normalizedValue.match(/:BTW:/i);
    if (betweenMatch) {
        let separatorIndex = betweenMatch.index;
        return {
            value: normalizedValue.slice(0, separatorIndex),
            operator: "BTW",
            endValue: normalizedValue.slice(separatorIndex + betweenMatch[0].length),
        };
    }

    let operatorMatch = normalizedValue.match(
        /:(GTE|LTE|EQ|LT|GT|CUS|IN|NIN|NE|EXISTS)$/i
    );
    if (!operatorMatch) return { value: normalizedValue, operator: "EQ" };

    return {
        value: normalizedValue.slice(0, operatorMatch.index),
        operator: operatorMatch[1].toUpperCase(),
    };
}

function parseJsonArray(value, fieldName) {
    let parsedValue = JSON.parse(value);
    if (!Array.isArray(parsedValue)) {
        throw new TypeError(`${fieldName} must be a JSON array`);
    }
    return parsedValue;
}

function constructCustomDateSearchValue(fieldPath, dateValue) {
    return escapeRegex(dateValue);
}

let fieldSpecificFilters = {
    EXACTMATCH: function (fieldPath, fieldValue) {
        return {
            [fieldPath]: {
                $in: fieldValue.split(","),
            },
        };
    },
    CURRENCY: function (fieldPath, fieldValue) {
        fieldPath = `${fieldPath}.amount`;
        return fieldSpecificFilters["NUMBER"](fieldPath, fieldValue);
    },
    REFERENCE: function (fieldPath, fieldValue, fieldDef) {
        let { displayFields, visibleInSingleColumn } = fieldDef;
        const regex = /\b(id|sys_gUid)\b/i;
        fieldPath = checkForNestedRefPath(fieldPath, fieldDef);
        if (visibleInSingleColumn && !regex.test(fieldPath)) {
            return {
                $or: displayFields.map((e) => {
                    if (e.name.split(".").length > 1) {
                        //Nested reference
                        return {
                            [`${fieldPath}.${e.name.split(".")[e.name.split(".").length - 1]
                                }`]: {
                                $regex: escapeRegex(fieldValue),
                                $options: "i",
                            },
                        };
                    } else {
                        return {
                            [`${fieldPath}.${e.name}`]: {
                                $regex: escapeRegex(fieldValue),
                                $options: "i",
                            },
                        };
                    }
                }),
            };
        } else {
            let isCommaSeparateMultiValue = fieldValue.split(",").length > 1;
            if (isCommaSeparateMultiValue) {
                return {
                    [fieldPath]: {
                        $in: fieldValue.split(","),
                    },
                };
            } else {
                return {
                    [fieldPath]: {
                        $regex: escapeRegex(fieldValue),
                        $options: "i",
                    },
                };
            }
        }
    },
    DATE: function (fieldPath, fieldValue) {
        let parsedFilter = parseFilterValue(fieldValue);
        let operator = getOperator(fieldValue);
        let dateValue = parsedFilter.value;
        if (operator === "$eq") {
            return {
                [fieldPath]: {
                    $regex: escapeRegex(dateValue),
                    $options: "i",
                },
            };
        } else if (operator === "$cus") {
            return {
                [fieldPath]: {
                    $regex: constructCustomDateSearchValue(fieldPath, dateValue),
                    $options: "i",
                },
            };
        } else if (operator === "$btw") {
            let endDateValue = parsedFilter.endValue;
            return {
                [fieldPath]: {
                    $gte: new Date(dateValue).toISOString(),
                    $lte: new Date(endDateValue).toISOString(),
                },
            };
        } else {
            return {
                [fieldPath]: {
                    [`${operator}`]: new Date(dateValue).toISOString(),
                },
            };
        }
    },
    DATETIME: function (fieldPath, fieldValue) {
        let parsedFilter = parseFilterValue(fieldValue);
        let operator = getOperator(fieldValue);
        let dateTimeValue = parsedFilter.value;
        if (operator === "$eq") {
            return {
                [fieldPath]: {
                    $regex: escapeRegex(dateTimeValue),
                    $options: "i",
                },
            };
        } else if (operator === "$btw") {
            let endDateTimeValue = parsedFilter.endValue;
            return {
                [fieldPath]: {
                    $gte: new Date(dateTimeValue).toISOString(),
                    $lte: new Date(endDateTimeValue).toISOString(),
                },
            };
        } else {
            return {
                [fieldPath]: {
                    [`${operator}`]: new Date(dateTimeValue).toISOString(),
                },
            };
        }
    },
    ARRAY: function () { },
    ORDER: function (fieldPath, fieldValue) { },
    NUMBER: function (fieldPath, fieldValue) {
        let operator = getOperator(fieldValue);
        fieldValue = parseFilterValue(fieldValue).value;
        let numericValue = Number(fieldValue);
        if (!Number.isFinite(numericValue)) {
            throw new TypeError("Invalid numeric filter value");
        }
        return {
            [fieldPath]: {
                [`${operator}`]: numericValue,
            },
        };
    },
    DECIMAL: function (fieldPath, fieldValue) {
        return fieldSpecificFilters["NUMBER"](fieldPath, fieldValue);
    },
    PAIREDLIST: function (fieldPath, fieldValue, fieldDef) {
        let { visibleInSingleColumn } = fieldDef;
        if (visibleInSingleColumn) {
            let { labels } = fieldDef;
            let { name, child } = labels;
            return {
                $or: [
                    {
                        [`${fieldPath}.${name}.id`]: {
                            $regex: escapeRegex(fieldValue),
                            $options: "i",
                        },
                    },
                    {
                        [`${fieldPath}.${child.name}.id`]: {
                            $regex: escapeRegex(fieldValue),
                            $options: "i",
                        },
                    },
                ],
            };
        } else {
            //handle for multiple Value
            return {
                [`${fieldPath}.id`]: {
                    $regex: escapeRegex(fieldValue),
                    $options: "i",
                },
            };
        }
    },
    PHONENUMBER: function (fieldPath, fieldValue) {
        fieldPath = `${fieldPath}.phoneNumber`;
        return {
            [fieldPath]: {
                $regex: escapeRegex(fieldValue),
                $options: "i",
            },
        };
    },
    DATAPAIREDLIST: function (fieldPath, fieldValue, fieldDef) {
        let { visibleInSingleColumn } = fieldDef;
        if (visibleInSingleColumn) {
            let { labels } = fieldDef;
            let { name, child } = labels;
            return {
                $or: [
                    {
                        [`${fieldPath}.${name}.text`]: {
                            $regex: escapeRegex(fieldValue),
                            $options: "i",
                        },
                    },
                    {
                        [`${fieldPath}.${child.name}.text`]: {
                            $regex: escapeRegex(fieldValue),
                            $options: "i",
                        },
                    },
                ],
            };
        } else {
            //handle for multiple Value
            return {
                [`${fieldPath}.text`]: {
                    $regex: escapeRegex(fieldValue),
                    $options: "i",
                },
            };
        }
    },
    RADIO: function (fieldPath, fieldValue, fieldDef) {
        let { values } = fieldDef;
        let selectedValue = values.find((e) => e.title === fieldValue);
        if (!selectedValue) throw new TypeError("Invalid radio filter value");
        fieldValue = selectedValue.value;
        return {
            [fieldPath]: fieldValue,
        };
    },
    TOGGLE: function (fieldPath, fieldValue) {
        let isBoolean = [
            "True",
            "true",
            "TRUE",
            "FALSE",
            "False",
            "false",
        ].includes(fieldValue);
        return {
            [fieldPath]: isBoolean ? fieldValue.toLowerCase() === "true" : fieldValue,
        };
    },
    GEOFENCE: function (fieldPath, fieldValue) { },
    // 'PROXIMITY': function(fieldPath,fieldValue){

    // },
    LATLONG: function (fieldPath, fieldValue, fieldDef) {
        const fields = [...(fieldDef?.fields || []), { name: "formattedAddress" }];
        return {
            $or: fields.map((field) => {
                return {
                    [`${fieldPath}.${field.name}`]: {
                        $regex: escapeRegex(fieldValue),
                        $options: "i",
                    },
                };
            }),
        };
    },
    default: function (fieldPath, fieldValue) {
        if (fieldValue.includes("u_c")) {
            //To handle the unique check
            return {
                [fieldPath]: fieldValue.split(":")[0],
            };
        } else {
            let multiValue = fieldValue.split(",");
            if (multiValue.length > 1) {
                return {
                    [fieldPath]: {
                        $in: multiValue,
                    },
                };
            } else {
                return {
                    [fieldPath]: {
                        $regex: escapeRegex(fieldValue),
                        $options: "i",
                    },
                };
            }
        }
    },
};

function isNJAdmin(user = null) {
    if (user) {
        let { role } = user.sys_entityAttributes || null;
        if (role && role.toUpperCase() === "ASSETGOV-ADMIN") {
            return true;
        } else {
            return false;
        }
    } else {
        return false;
    }
}

function isSuperAdmin(user = null) {
    if (user) {
        let { superAdmin } = user.sys_entityAttributes || null;
        if (superAdmin) {
            return true;
        } else {
            return false;
        }
    } else {
        return false;
    }
}

function constructGlobalSearchQuery({
    query = [],
    template,
    value,
    pageLayout,
}) {
    let STRING_TYPES = [
        "TEXTBOX",
        "TEXTAREA",
        "EMAIL",
        "LIST",
        "SEQUENCE",
        "REFERENCE",
        "DATE",
        "DATETIME",
        "DATERANGE",
        "DATAPAIREDLIST",
        "PAIREDLIST",
        "PHONENUMBER",
        "ORDER",
        "LATLONG",
    ];
    let { sys_topLevel } = template.sys_entityAttributes;

    let globalQuery = {
        $or: [],
    };

    if (pageLayout) {
        globalQuery = {
            ...globalQuery,
            sys_templateName: pageLayout,
        };
    }

    STRING_TYPES.map((typeName) => {
        let fields = sys_topLevel.filter((field) => field.type === typeName);

        if (fields && fields.length) {
            fields.map((fieldDef) => {
                if (fieldDef.type === "REFERENCE") {
                    let { name } = fieldDef || {};
                    fieldDef.displayFields.map((refDef) => {
                        let { name: eachDFName } = refDef || {};
                        let splitted = eachDFName.split(".");
                        if (splitted.length > 1) {
                            let refFieldName = splitted[1];
                            if (refDef.type && refDef.type.toUpperCase() === "NUMBER") {
                                globalQuery["$or"].push({
                                    [`sys_entityAttributes.${name}.${refFieldName}`]:
                                        parseInt(value),
                                });
                            } else {
                                globalQuery["$or"].push({
                                    [`sys_entityAttributes.${name}.${refFieldName}`]: {
                                        $regex: escapeRegex(value),
                                        $options: "i",
                                    },
                                });
                            }
                        } else {
                            if (refDef.type && refDef.type.toUpperCase() === "NUMBER") {
                                globalQuery["$or"].push({
                                    [`sys_entityAttributes.${fieldDef.name}.${refDef.name}`]:
                                        parseInt(value),
                                });
                            } else {
                                globalQuery["$or"].push({
                                    [`sys_entityAttributes.${fieldDef.name}.${refDef.name}`]: {
                                        $regex: escapeRegex(value),
                                        $options: "i",
                                    },
                                });
                            }
                        }
                    });
                } else if (fieldDef.type === "DATERANGE") {
                    ["startDate", "endDate"].map((e) => {
                        globalQuery["$or"].push({
                            [`sys_entityAttributes.${fieldDef.name}.${e}`]: {
                                $regex: escapeRegex(value),
                                $options: "i",
                            },
                        });
                    });
                } else if (
                    fieldDef.type === "PAIREDLIST" ||
                    fieldDef.type === "DATAPAIREDLIST"
                ) {
                    let { labels } = fieldDef;
                    let { child } = labels;
                    let path = fieldDef.type === "DATAPAIREDLIST" ? "text" : "id";
                    let arr = [labels.name, child.name];
                    arr.map((e) => {
                        globalQuery["$or"].push({
                            [`sys_entityAttributes.${fieldDef.name}.${e}.${path}`]: {
                                $regex: escapeRegex(value),
                                $options: "i",
                            },
                        });
                    });
                } else if (fieldDef.type === "PHONENUMBER") {
                    globalQuery["$or"].push({
                        [`sys_entityAttributes.${fieldDef.name}.phoneNumber`]: {
                            $regex: escapeRegex(value),
                            $options: "i",
                        },
                    });
                } else if (fieldDef.type === "ORDER") {
                    if (fieldDef.fields && fieldDef.fields.length) {
                        fieldDef.fields.map((orderfield) => {
                            globalQuery["$or"].push({
                                [`sys_entityAttributes.${fieldDef.name}.${orderfield.name}`]: {
                                    $regex: escapeRegex(value),
                                    $options: "i",
                                },
                            });
                        });
                    }
                } else if (fieldDef.type === "LATLONG") {
                    const fields = [
                        ...(fieldDef?.fields || []),
                        { name: "formattedAddress" },
                    ];
                    fields.map((field) => {
                        globalQuery["$or"].push({
                            [`sys_entityAttributes.${fieldDef.name}.${field.name}`]: {
                                $regex: escapeRegex(value),
                                $options: "i",
                            },
                        });
                    });
                } else {
                    globalQuery["$or"].push({
                        [`sys_entityAttributes.${fieldDef.name}`]: {
                            $regex: escapeRegex(value),
                            $options: "i",
                        },
                    });
                }
            });
        }
    });
    return [globalQuery];
}

function constructFilters(params, template, globalTemplate = {}) {
    try {
        let coreKeys = [
            {
                sys_gUid: "sys_gUid",
            },
            {
                PAGELAYOUT: "sys_templateName",
            },
            {
                "sys_auditHistory.createdBy": "sys_auditHistory.createdBy",
            },
            {
                sys_ids: "_id",
            },
            {
                sys_groupName: "sys_groupName",
            },
        ];

        let { sys_topLevel = [] } = template.sys_entityAttributes || {};
        let { config = {} } = globalTemplate.sys_entityAttributes || {};

        let finalQuery = [],
            filterObj,
            fieldPath;

        //Still need to handle for nested objects
        if (Object.keys(params).length) {
            Object.keys(params)
                .filter((filterKey) => !["startDate", "endDate"].includes(filterKey))
                .map((filterKey) => {
                validateFieldPath(filterKey);
                let coreKeyIndex = coreKeys.findIndex((e) => e[filterKey]);
                if (coreKeyIndex != -1) {
                    fieldPath = coreKeys[coreKeyIndex][filterKey];
                } else {
                    fieldPath = `sys_entityAttributes.${filterKey}`;
                }
                let fieldValue = params[filterKey];
                let fieldName = filterKey.split(".")[0];
                let fieldDef = sys_topLevel.find((field) => field.name === fieldName);

                if (fieldDef) {
                    if (
                        Array.isArray(config.columnFilters) &&
                        config.columnFilters.find((field) => fieldDef.type === field.type)
                    ) {
                        filterObj = fieldSpecificFilters["EXACTMATCH"](
                            fieldPath,
                            fieldValue
                        );
                        finalQuery.push(filterObj);
                    } else {
                        filterObj = (
                            fieldSpecificFilters[fieldDef.type] ||
                            fieldSpecificFilters["default"]
                        )(fieldPath, fieldValue, fieldDef);
                        if (filterObj) {
                            finalQuery.push(filterObj);
                        } else {
                            finalQuery.push({
                                [fieldPath]: {
                                    $regex: escapeRegex(fieldValue),
                                    $options: "i",
                                },
                            });
                        }
                    }
                } else {
                    //Fields without definitions in the template
                    if (filterKey === "sys_ids") {
                        //Convert _id to ObejctIDs
                        fieldValue = parseJsonArray(fieldValue, "sys_ids");
                        if (fieldValue.length) {
                            finalQuery.push({
                                _id: {
                                    $in: fieldValue.map((e) => ObjectId.createFromHexString(e)),
                                },
                            });
                        }
                    } else if (filterKey === "sys_gUids") {
                        fieldValue = parseJsonArray(fieldValue, "sys_gUids");
                        if (fieldValue.length) {
                            finalQuery.push({
                                sys_gUid: {
                                    $in: fieldValue,
                                },
                            });
                        }
                    } else if (filterKey === "_notExists") {
                        fieldValue = parseJsonArray(fieldValue, "_notExists");
                        if (fieldValue.length) {
                            fieldValue.forEach((path) => {
                                validateFieldPath(path);
                                finalQuery.push({
                                    [path]: {
                                        $exists: false,
                                    },
                                });
                            });
                        }
                    } else if (filterKey === "isCalendar" && fieldValue === "true") {
                        let { sys_entityAttributes: { sys_calendar, sys_topLevel } = {} } =
                            template || {};
                        let { eventFields = [], filters = [] } = sys_calendar || {};
                        if (filters.length > 0) {
                            filters.forEach((e) => {
                                let path = `sys_entityAttributes.${e.key}`;
                                finalQuery.push({
                                    [path]: e.value,
                                });
                            });
                        }
                        if (eventFields.length > 0) {
                            let { startDate, endDate } = params;
                            let currentDate = new Date();

                            startDate =
                                startDate ||
                                new Date(
                                    currentDate.getFullYear(),
                                    currentDate.getMonth(),
                                    1
                                ).toISOString();
                            endDate =
                                endDate ||
                                new Date(
                                    currentDate.getFullYear(),
                                    currentDate.getMonth() + 1,
                                    0
                                ).toISOString();
                            eventFields.forEach((eachField) => {
                                ["startDate", "endDate"].forEach((key) => {
                                    if (eachField[key]) {
                                        let field = sys_topLevel.find(
                                            (e) => e.name === eachField[key]
                                        );
                                        if (field) {
                                            let fieldPath = `sys_entityAttributes.${field.name}`;
                                            let existingQueryIndex = finalQuery.findIndex(
                                                (e) => e.hasOwnProperty(fieldPath)
                                            );
                                            if (existingQueryIndex >= 0)
                                                finalQuery.splice(existingQueryIndex, 1);
                                            if (key === "startDate") {
                                                finalQuery.push({
                                                    [fieldPath]:
                                                        field.type === "DATERANGE"
                                                            ? {
                                                                startDate: { $gte: startDate, $lte: endDate },
                                                            }
                                                            : {
                                                                $gte: startDate,
                                                                $lte: endDate,
                                                            },
                                                });
                                            }
                                        }
                                    }
                                });
                            });
                        }
                    } else if (filterKey === "geoFenceSearch") {
                        fieldValue = parseJsonArray(fieldValue, "geoFenceSearch");
                        let filterMetadata =
                            template.sys_entityAttributes.sys_filterFields.find(
                                (e) => e.name === "geoFenceSearch"
                            );
                        if (fieldValue && fieldValue.length) {
                            fieldValue.map((eachShape) => {
                                let { type: shapeType, coords } = eachShape;
                                if (["rectangle", "polygon"].includes(shapeType)) {
                                    if (filterMetadata.elemMatch) {
                                        finalQuery.push({
                                            [filterMetadata.path]: {
                                                $elemMatch: {
                                                    $geoIntersects: {
                                                        $geometry: {
                                                            type: "Polygon",
                                                            coordinates: [coords],
                                                        },
                                                    },
                                                },
                                            },
                                        });
                                    } else {
                                        finalQuery.push({
                                            [filterMetadata.path]: {
                                                $geoIntersects: {
                                                    $geometry: {
                                                        type: "Polygon",
                                                        coordinates: [coords],
                                                    },
                                                },
                                            },
                                        });
                                    }
                                }
                            });
                        }
                    } else {
                        // Parsed the same way as the typed handlers above. A bare
                        // `split(":")` breaks any value that legitimately contains
                        // a colon — an ISO timestamp being the obvious one — by
                        // reading part of the value as the operator.
                        let parsedFilter = parseFilterValue(fieldValue);
                        let operator = parsedFilter.operator.toLowerCase();
                        fieldValue = parsedFilter.value;

                        // An unrecognised suffix is not an operator, so the whole
                        // string stays a literal value. Only the fixed set below
                        // can ever reach Mongo as `$<operator>`.
                        if (!SUPPORTED_QUERY_OPERATORS.has(operator)) {
                            throw new TypeError("Unsupported filter operator");
                        }

                        const multiValueOperators = ["in", "nin"];
                        let operatorValue = multiValueOperators.includes(operator)
                            ? fieldValue.split(",")
                            : operator === "exists"
                                ? fieldValue.toLowerCase() === "true"
                                : fieldValue;
                        finalQuery.push({
                            [fieldPath]: {
                                [`$${operator}`]: operatorValue,
                            },
                        });

                    }
                }
            });
        }
        return finalQuery;
    } catch (e) {
        throw e;
    }
}

function getSearchKeys(params) {
    let nonSearchKeys = [
        "skip",
        "limit",
        "templateName",
        "page",
        "sortby",
        "orderby",
        "sys_agencyId",
        "globalsearch",
        "pageNumber",
        "sample",
        "skipPermissions",
    ];
    let extractedParams = { ...params };
    nonSearchKeys.map((key) => {
        if (Object.prototype.hasOwnProperty.call(extractedParams, key)) {
            delete extractedParams[key];
        }
    });

    return extractedParams;
}

function constructOrgFilters(orgFilterProps) {
    try {
        let {
            userData = {},
            template = {},
            userRoleData = {},
        } = orgFilterProps || {};
        let { defaultFilters = {} } = template?.sys_entityAttributes || {};
        let {
            roleName: { sys_gUid: userRoleGuid = "" },
        } = userData?.sys_entityAttributes || {};
        if (userRoleGuid) {
            // let userRoleData = await entityModel.getOneData('role', { "sys_gUid": userRoleGuid });
            if (userRoleData[1]) {
                let { organizationGroup = [] } = userRoleData[1]?.sys_entityAttributes;
                if (organizationGroup) {
                    let orgFilter = organizationGroup?.map((e) => e?.divisionName);
                    if (Object.keys(defaultFilters).length && orgFilter?.length) {
                        let fieldPath = defaultFilters?.fieldPath;
                        return [{ [`${fieldPath}`]: { $in: orgFilter } }];
                    } else return [];
                } else return [];
            } else return [];
        } else return [];
    } catch (e) {
        return [];
    }
}

const checkAccess = (checkAccessProps) => {
    try {
        let { appname, modulename, entityname, permissionType, user, permissions } =
            checkAccessProps;
        if (isNJAdmin(user)) return true;
        else {
            try {
                return permissions.apps
                    .find((a) => a.name === appname)
                    .modules.find((m) => m.name === modulename)
                    .entities.find((e) => e.groupName === entityname).access[
                    permissionType
                ];
            } catch (e) {
                return false;
            }
        }
    } catch (e) {
        return false;
    }
};

function getPermittedEntities(roleData) {
    try {
        let { rolePermission = {} } = roleData?.sys_entityAttributes || {};
        let permittedEntities = [];
        rolePermission.apps.map((eachApp) => {
            eachApp.modules.map((eachModule) => {
                eachModule.entities.map((eachEntity) => {
                    permittedEntities.push(eachEntity.groupName);
                });
            });
        });
        return permittedEntities;
    } catch (e) {
        return [];
    }
}

function constructDenyAllFilters() {
    return [
        {
            _id: {
                $in: [],
            },
        },
    ];
}

function constructPermittedEntitiesFilters(props) {
    try {
        let { appname, modulename, entityname, user, agency, roleData } =
            props || {};
        let { roleName = {} } = user?.sys_entityAttributes || {};
        let { agencyPermission = {} } = agency?.sys_entityAttributes || {};

        if (roleName?.sys_gUid) {
            // let [rError, roleData] = await entityModel.getOneData('role', { sys_gUid: roleName?.sys_gUid });
            let { rolePermission = {} } = roleData?.sys_entityAttributes || {};

            let roleLevelAccess = checkAccess({
                appname,
                modulename,
                entityname,
                user,
                agency,
                permissionType: "showPermittedEntities",
                permissions: rolePermission,
            });
            let agencyLevelAccess = checkAccess({
                appname,
                modulename,
                entityname,
                user,
                permissionType: "showPermittedEntities",
                permissions: agencyPermission,
            });

            if (roleLevelAccess && agencyLevelAccess) {
                let permittedEntities = getPermittedEntities(roleData) || [];
                return permittedEntities.length
                    ? [
                        {
                            [`${"sys_entityAttributes.groupName"}`]: {
                                $in: permittedEntities,
                            },
                        },
                    ]
                    : constructDenyAllFilters();
            } else return constructDenyAllFilters();
        } else return [];
    } catch (e) {
        return constructDenyAllFilters();
    }
}

function checkEligibleForEntityBuilder(props) {
    try {
        let { entityname = "", modulename = "", agency = {}, user = {} } = props;
        let { enableMetaDataEditorAtAgency = false } =
            agency?.sys_entityAttributes || {};

        if (
            entityname === "EntityTemplate" &&
            modulename === "Admin" &&
            !isNJAdmin(user) &&
            enableMetaDataEditorAtAgency
        ) {
            return true;
        } else return false;
    } catch (e) {
        return false;
    }
}

function constructEntityBuilderFilters(props) {
    try {
        const {
            modulename,
            entityname,
            user = {},
            agency = {},
            roleData = {},
        } = props || {};
        const isValidateForEntityBuilder = checkEligibleForEntityBuilder({
            entityname,
            modulename,
            agency,
            user,
        });

        if (isValidateForEntityBuilder) {
            const roleGuid = user?.sys_entityAttributes?.roleName?.sys_gUid;
            const agencyPermission =
                agency?.sys_entityAttributes?.agencyPermission || {};
            let permissionSource = {};
            let permittedEntityTemplateList = [];

            if (isSuperAdmin(user)) {
                permissionSource = agencyPermission;
            } else if (roleGuid) {
                // const [rError, roleData] = await entityModel.getOneData('role', { sys_gUid: roleGuid });
                permissionSource = roleData?.sys_entityAttributes?.rolePermission || {};
            }

            let permissionApps = permissionSource.apps || [];
            permissionApps.map((eachApp) => {
                eachApp.modules.map((eachModule) => {
                    eachModule.entities.map((eachEntity) => {
                        if (eachEntity?.featureAccess?.disableMetaDataEditor !== true) {
                            permittedEntityTemplateList.push(eachEntity.name);
                        }
                    });
                });
            });

            return permittedEntityTemplateList.length
                ? [
                    {
                        [`${"sys_entityAttributes.sys_templateName"}`]: {
                            $in: permittedEntityTemplateList,
                        },
                    },
                ]
                : constructDenyAllFilters();
        } else return [];
    } catch (e) {
        return constructDenyAllFilters();
    }
}

function constructFinalQuery(queryStages) {
    let {
        finalMatchQuery = [],
        globalSearchQuery = [],
        agencyFilters = [],
        heirarchyFilters = [],
        orgFilters = [],
        permittedEntitiesFilters = [],
        skip = 0,
        limit = 25,
        sortby,
        orderby,
        entityBuilderFilters = [],
    } = queryStages || {};
    let dataQueryStages = [],
        countQueryStages = [];

    skip = Number(skip);
    limit = Number(limit);
    if (!Number.isInteger(skip) || skip < 0) throw new TypeError("Invalid skip value");
    if (!Number.isInteger(limit) || limit < 1) throw new TypeError("Invalid limit value");

    let isHeirarchyFiltersApplied = heirarchyFilters && heirarchyFilters.length;
    let isEntityBuilderFiltersApplied =
        entityBuilderFilters && entityBuilderFilters.length;

    let match = {
        $match: {
            $and: [
                ...finalMatchQuery,
                ...agencyFilters,
                ...globalSearchQuery,
                ...orgFilters,
                ...permittedEntitiesFilters,
                ...(isHeirarchyFiltersApplied ? [{ $or: heirarchyFilters }] : []),
                ...(isEntityBuilderFiltersApplied
                    ? [{ $or: entityBuilderFilters }]
                    : []),
            ],
        },
    };

    let hasMatchFilters = match.$match.$and.length > 0;
    if (hasMatchFilters) {
        dataQueryStages.push(match);
        countQueryStages.push(match, { $count: "total_count" });
    } else {
        countQueryStages.push({ $count: "total_count" });
    }

    let sortBy = sortby
        ? `sys_entityAttributes.${validateFieldPath(sortby)}`
        : "_id";
    let orderBy = orderby ? parseInt(orderby) : -1;
    if (![1, -1].includes(orderBy)) throw new TypeError("Invalid sort order");

    dataQueryStages = [
        ...dataQueryStages,
        ...[
            {
                $sort: {
                    [sortBy]: orderBy,
                },
            },
            {
                $skip: skip,
            },
            {
                $limit: limit,
            },
        ],
    ];

    return {
        dataQueryStages,
        countQueryStages,
    };
}

function getOperator(value) {
    let operator = {
        GTE: "$gte",
        LTE: "$lte",
        EQ: "$eq",
        LT: "$lt",
        GT: "$gt",
        BTW: "$btw",
        CUS: "$cus",
        IN: "$in",
        NIN: "$nin",
        NE: "$ne",
    };

    const op = parseFilterValue(value).operator;

    return operator[op] || "$eq";
}

function isObjectEmpty(obj) {
    if (obj && typeof obj === "object") {
        if (Object.keys(obj).length) {
            return false;
        } else {
            return true;
        }
    } else {
        return false;
    }
}

const checkForNestedRefPath = (fieldPath, fieldMeta, addAttributes = true) => {
    if (!fieldPath && isObjectEmpty(fieldMeta)) return fieldPath;
    else {
        let { displayFields, name } = fieldMeta || {};
        let isNestedExist = displayFields?.some(
            (e) => e?.name?.split(".").length > 1
        );
        if (isNestedExist) {
            let pathArr = fieldPath.split(".");
            let lastIndexedField = pathArr[pathArr?.length - 1];
            let path = addAttributes
                ? `sys_entityAttributes.${name}.${lastIndexedField}`
                : `${name}.${lastIndexedField}`;
            return path;
        } else return fieldPath;
    }
};

module.exports = {
    constructGlobalSearchQuery,
    constructFilters,
    getSearchKeys,
    constructOrgFilters,
    constructPermittedEntitiesFilters,
    constructEntityBuilderFilters,
    constructFinalQuery,
    getOperator,
    isObjectEmpty,
    checkForNestedRefPath,
};
