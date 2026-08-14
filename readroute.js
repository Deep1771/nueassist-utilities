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
                                $regex: fieldValue,
                                $options: "i",
                            },
                        };
                    } else {
                        return {
                            [`${fieldPath}.${e.name}`]: {
                                $regex: fieldValue,
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
                        $regex: fieldValue,
                        $options: "i",
                    },
                };
            }
        }
    },
    DATE: function (fieldPath, fieldValue) {
        let operator = getOperator(fieldValue);
        let dateValue = fieldValue.split(":")[0];
        if (operator === "$eq") {
            return {
                [fieldPath]: {
                    $regex: dateValue,
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
            let endDateValue = fieldValue.split(":")[2];
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
        let operator = getOperator(fieldValue);
        let dateTimeValue = fieldValue.split(":")[0];
        if (operator === "$eq") {
            return {
                [fieldPath]: {
                    $regex: dateTimeValue,
                    $options: "i",
                },
            };
        } else if (operator === "$btw") {
            let endDateTimeValue = fieldValue.split(":")[2];
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
        fieldValue = fieldValue.split(":")[0];
        return {
            [fieldPath]: {
                [`${operator}`]: parseInt(fieldValue),
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
                            $regex: fieldValue,
                            $options: "i",
                        },
                    },
                    {
                        [`${fieldPath}.${child.name}.id`]: {
                            $regex: fieldValue,
                            $options: "i",
                        },
                    },
                ],
            };
        } else {
            //handle for multiple Value
            return {
                [`${fieldPath}.id`]: {
                    $regex: fieldValue,
                    $options: "i",
                },
            };
        }
    },
    PHONENUMBER: function (fieldPath, fieldValue) {
        fieldPath = `${fieldPath}.phoneNumber`;
        return {
            [fieldPath]: {
                $regex: fieldValue,
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
                            $regex: fieldValue,
                            $options: "i",
                        },
                    },
                    {
                        [`${fieldPath}.${child.name}.text`]: {
                            $regex: fieldValue,
                            $options: "i",
                        },
                    },
                ],
            };
        } else {
            //handle for multiple Value
            return {
                [`${fieldPath}.text`]: {
                    $regex: fieldValue,
                    $options: "i",
                },
            };
        }
    },
    RADIO: function (fieldPath, fieldValue, fieldDef) {
        let { values } = fieldDef;
        fieldValue = values.find((e) => e.title === fieldValue).value;
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
            [fieldPath]: isBoolean ? JSON.parse(fieldValue) : fieldValue,
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
                        $regex: `.*${fieldValue}.*`,
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
                        $regex: fieldValue,
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
                                        $regex: `.*${value}.*`,
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
                                        $regex: `.*${value}.*`,
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
                                $regex: `.*${value}.*`,
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
                                $regex: `.*${value}.*`,
                                $options: "i",
                            },
                        });
                    });
                } else if (fieldDef.type === "PHONENUMBER") {
                    globalQuery["$or"].push({
                        [`sys_entityAttributes.${fieldDef.name}.phoneNumber`]: {
                            $regex: `.*${value}.*`,
                            $options: "i",
                        },
                    });
                } else if (fieldDef.type === "ORDER") {
                    if (fieldDef.fields && fieldDef.fields.length) {
                        fieldDef.fields.map((orderfield) => {
                            globalQuery["$or"].push({
                                [`sys_entityAttributes.${fieldDef.name}.${orderfield.name}`]: {
                                    $regex: `.*${value}`,
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
                                $regex: `.*${value}.*`,
                                $options: "i",
                            },
                        });
                    });
                } else {
                    globalQuery["$or"].push({
                        [`sys_entityAttributes.${fieldDef.name}`]: {
                            $regex: `.*${value}.*`,
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

        let { sys_topLevel } = template.sys_entityAttributes;
        let { config } = globalTemplate ? globalTemplate.sys_entityAttributes : {};

        let finalQuery = [],
            filterObj,
            isCoreKey,
            fieldPath;

        //Still need to handle for nested objects
        if (Object.keys(params).length) {
            Object.keys(params).map((filterKey) => {
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
                        config &&
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
                                    $regex: fieldValue,
                                    $options: "i",
                                },
                            });
                        }
                    }
                } else {
                    //Fields without definitions in the template
                    if (filterKey === "sys_ids") {
                        //Convert _id to ObejctIDs
                        fieldValue = JSON.parse(fieldValue);
                        console.log("fieldValue", fieldValue);
                        if (fieldValue.length) {
                            finalQuery.push({
                                _id: {
                                    $in: fieldValue.map((e) => new ObjectId(e)),
                                },
                            });
                        }
                    } else if (filterKey === "sys_gUids") {
                        fieldValue = JSON.parse(fieldValue);
                        console.log("fieldValue", fieldValue);
                        if (fieldValue.length) {
                            finalQuery.push({
                                sys_gUid: {
                                    $in: fieldValue,
                                },
                            });
                        }
                    } else if (filterKey === "_notExists") {
                        fieldValue = JSON.parse(fieldValue);
                        if (fieldValue.length) {
                            fieldValue.forEach((path) => {
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
                            let { startDate, endDate } = request.query;
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
                                            let existingQueryIndex = finalQuery["$and"].findIndex(
                                                (e) => e.hasOwnProperty(fieldPath)
                                            );
                                            if (existingQueryIndex >= 0)
                                                finalQuery["$and"].splice(existingQueryIndex, 1);
                                            if (key === "startDate") {
                                                finalQuery["$and"].push({
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
                        fieldValue = JSON.parse(fieldValue);
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
                        let operator = fieldValue.split(":")[1]
                            ? fieldValue.split(":")[1].toLowerCase()
                            : "eq";
                        fieldValue = fieldValue.split(":")[0];

                        const multiValueOperators = ["in", "nin"];

                        console.log("operator", { operator, fieldValue, fieldPath });
                        finalQuery.push({
                            [fieldPath]: {
                                [`$${operator}`]: multiValueOperators.includes(operator)
                                    ? fieldValue.split(",")
                                    : fieldValue,
                            },
                        });

                    }
                    console.log(`Field definition does not exist ${fieldName}`);
                }
            });
        }
        return finalQuery;
    } catch (e) {
        console.error("Error reported in construct filters", e);
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
        if (Object.keys(extractedParams).indexOf(key !== -1)) {
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
        console.log("Error in constructOrgFilters ", e);
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
        console.log("Error in checkAccess ", e);
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
        console.log("Error in getPermittedEntities ", e);
    }
}

function constructPermittedEntitiesFilters(props) {
    try {
        let { appname, modulename, entityname, user, agency, roleData } =
            props || {};
        let { roleName = {} } = user?.sys_entityAttributes || {};
        let { agencyPermission = {} } = agency?.sys_entityAttributes || {};
        let permittedEntitiesFilters = [];

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
                permittedEntitiesFilters = constructPermittedEntitiesFilters(roleData);
                let permittedEntities = getPermittedEntities(roleData);
                return permittedEntities.length
                    ? [
                        {
                            [`${"sys_entityAttributes.groupName"}`]: {
                                $in: permittedEntities,
                            },
                        },
                    ]
                    : [];
            } else return [];
        } else return [];
    } catch (e) {
        console.log("Error in constructPermittedEntitiesFilters ", e);
        return [];
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
        console.log("error in checkEligibleForEntityBuilder :", e);
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

            permissionSource.apps.map((eachApp) => {
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
                : [];
        } else return [];
    } catch (e) {
        console.error("error in constructEntityBuilderFilters :", e);
        return [];
    }
}

function constructFinalQuery(queryStages) {
    //Handle errors
    let finalQueryParameters = JSON.parse(JSON.stringify(queryStages));
    let {
        finalMatchQuery,
        globalSearchQuery,
        agencyFilters,
        heirarchyFilters,
        orgFilters,
        permittedEntitiesFilters,
        skip,
        limit,
        sortby,
        orderby,
        entityBuilderFilters,
    } = finalQueryParameters;
    let dataQueryStages = [],
        countQueryStages = [];

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

    if (finalMatchQuery.length || agencyFilters.length) {
        dataQueryStages.push(match);
        countQueryStages.push(match, { $count: "total_count" });
    } else {
        countQueryStages.push({ $count: "total_count" });
    }

    let sortBy = sortby ? `sys_entityAttributes.${sortby}` : "_id";
    let orderBy = orderby ? parseInt(orderby) : -1;

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

    const op = value.split(":")[1];

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