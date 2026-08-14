 export function constructGlobalSearchQuery({query=[],template,value,pageLayout}){
    let STRING_TYPES = ['TEXTBOX', 'TEXTAREA', 'EMAIL', 'LIST', 'SEQUENCE',
    'REFERENCE', 'DATE', 'DATETIME', 'DATERANGE', 'PAIREDLIST', 'PHONENUMBER','ORDER'
];
let { sys_topLevel} = template.sys_entityAttributes;

let globalQuery = {
    '$or': [],
};

if (pageLayout) {t
    globalQuery = {
        ...globalQuery,
        "sys_templateName": pageLayout
    }
}


STRING_TYPES.map(typeName => {
    let fields = sys_topLevel.filter(field => field.type === typeName);

    if (fields && fields.length) {
        fields.map(fieldDef => {
            if (fieldDef.type === 'REFERENCE') {

                fieldDef.displayFields.map(refDef => {
                    if (refDef.name.split('.').length > 1) {
                        let refObjName = refDef.name.split('.')[0]
                        let refFieldName = refDef.name.split('.')[1]
                        if (refDef.type && refDef.type.toUpperCase() === 'NUMBER') {
                            globalQuery['$or'].push({
                                [`sys_entityAttributes.${refObjName}.${refFieldName}`]: parseInt(value)
                            })
                        } else {
                            globalQuery['$or'].push({
                                [`sys_entityAttributes.${refObjName}.${refFieldName}`]: {
                                    '$regex': `.*${value}.*`,
                                    '$options': 'i'
                                }
                            })
                        }
                    } else {
                        if (refDef.type && refDef.type.toUpperCase() === 'NUMBER') {
                            globalQuery['$or'].push({
                                [`sys_entityAttributes.${fieldDef.name}.${refDef.name}`]: parseInt(value)
                            })
                        } else {
                            globalQuery['$or'].push({
                                [`sys_entityAttributes.${fieldDef.name}.${refDef.name}`]: {
                                    '$regex': `.*${value}.*`,
                                    '$options': 'i'
                                }
                            })
                        }

                    }
                })
            } else if (fieldDef.type === 'DATERANGE') {
                ['startDate', 'endDate'].map(e => {
                    globalQuery['$or'].push({
                        [`sys_entityAttributes.${fieldDef.name}.${e}`]: {
                            '$regex': `.*${value}.*`,
                            '$options': 'i'
                        }
                    })
                })
            } else if (fieldDef.type === 'PAIREDLIST' || fieldDef.type === 'DATAPAIREDLIST') {
                let { labels } = fieldDef
                let { child } = labels
                let arr = [labels.name, child.name]
                arr.map(e => {
                    globalQuery['$or'].push({
                        [`sys_entityAttributes.${fieldDef.name}.${e}.id`]: {
                            '$regex': `.*${value}.*`,
                            '$options': 'i'
                        }
                    })
                })
            } else if (fieldDef.type === 'PHONENUMBER') {
                globalQuery['$or'].push({
                    [`sys_entityAttributes.${fieldDef.name}.phoneNumber`]: {
                        '$regex': `.*${value}.*`,
                        '$options': 'i'
                    }
                })
            } else if(fieldDef.type === 'ORDER'){
                if(fieldDef.fields && fieldDef.fields.length){
                    fieldDef.fields.map(orderfield=>{
                        globalQuery['$or'].push({
                            [`sys_entityAttributes.${fieldDef.name}.${orderfield.name}`]:{
                                '$regex': `.*${value}`,
                                '$options': 'i'
                            }
                        })
                    })
                }
            }
            else {
                globalQuery['$or'].push({
                    [`sys_entityAttributes.${fieldDef.name}`]: {
                        '$regex': `.*${value}.*`,
                        '$options': 'i'
                    }
                })
            }
        })
    }
})
return [globalQuery]
}

module.exports = {
	constructGlobalSearchQuery
}
